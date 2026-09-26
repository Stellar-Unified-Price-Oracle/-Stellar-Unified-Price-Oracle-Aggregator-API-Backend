#!/usr/bin/env node
/**
 * #552 — Gate releases on SLO error-budget burn rate.
 *
 * Evaluates whether an upcoming release is permitted, blocked, or degraded based on
 * real-time SLO error budget burn rates and remaining 30-day budget.
 *
 * Usage:
 *   node scripts/slo-release-gate.js [--environment=production] [--prometheus-url=http://localhost:9090]
 *   node scripts/slo-release-gate.js --override-reason="HOTFIX incident INC-123" --override-approver="sre@stellar.org"
 *   node scripts/slo-release-gate.js --input-metrics=./test-metrics.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SloEvaluationInput {
  canonical1hBurnRate: number;
  canonical6hBurnRate: number;
  canonical24hBurnRate: number;
  remainingBudgetPercent: number;
  canaryBurnRate?: number;
  metricsAvailable?: boolean;
}

export type GateDecision = 'PERMIT' | 'DEGRADED_PERMIT' | 'BLOCK' | 'OVERRIDDEN_PERMIT';

export interface GateResult {
  decision: GateDecision;
  exitCode: number;
  reasons: string[];
  metrics: SloEvaluationInput;
  environment: string;
  overrideApplied?: boolean;
  overrideReason?: string;
  overrideApprover?: string;
}

export function evaluateSloGate(
  input: SloEvaluationInput,
  options: {
    environment?: string;
    overrideReason?: string;
    overrideApprover?: string;
    allowMetricsUnavailable?: boolean;
  } = {},
): GateResult {
  const env = options.environment || 'production';
  const reasons: string[] = [];

  // 1. Check metrics availability
  if (input.metricsAvailable === false) {
    if (env === 'production' && !options.allowMetricsUnavailable && !options.overrideReason) {
      return {
        decision: 'BLOCK',
        exitCode: 1,
        reasons: ['Prometheus SLO metrics unavailable in production (FAIL_CLOSED policy enforced)'],
        metrics: input,
        environment: env,
      };
    } else {
      reasons.push('Prometheus SLO metrics unavailable; continuing under WARN_AND_PERMIT policy');
      return {
        decision: options.overrideReason ? 'OVERRIDDEN_PERMIT' : 'PERMIT',
        exitCode: 0,
        reasons,
        metrics: input,
        environment: env,
        overrideApplied: Boolean(options.overrideReason),
        overrideReason: options.overrideReason,
        overrideApprover: options.overrideApprover,
      };
    }
  }

  // 2. Evaluate burn rates & budget exhaustion
  let blocked = false;
  let degraded = false;

  if (input.remainingBudgetPercent <= 0) {
    blocked = true;
    reasons.push(`Monthly error budget completely exhausted (${input.remainingBudgetPercent.toFixed(1)}% remaining)`);
  }

  if (input.canonical1hBurnRate >= 14.4) {
    blocked = true;
    reasons.push(
      `Fast burn rate critical: 1h burn rate is ${input.canonical1hBurnRate.toFixed(1)}x (threshold: >= 14.4x; consuming 2% of budget/hr)`,
    );
  }

  if (input.canonical6hBurnRate >= 6.0) {
    blocked = true;
    reasons.push(
      `Fast burn rate high: 6h burn rate is ${input.canonical6hBurnRate.toFixed(1)}x (threshold: >= 6.0x; consuming 5% of budget in 6hr)`,
    );
  }

  if (input.canonical24hBurnRate >= 3.0 && !blocked) {
    degraded = true;
    reasons.push(
      `Slow burn rate elevated: 24h burn rate is ${input.canonical24hBurnRate.toFixed(1)}x (threshold: >= 3.0x; consuming 10% of budget/day)`,
    );
  }

  // Note on canary isolation:
  if (input.canaryBurnRate !== undefined && input.canaryBurnRate > 0) {
    reasons.push(
      `Canary-isolated burn rate observed at ${input.canaryBurnRate.toFixed(1)}x (isolated from canonical deployment gate)`,
    );
  }

  // 3. Handle overrides
  if (options.overrideReason) {
    const approver = options.overrideApprover || 'anonymous-operator';
    recordOverrideAudit({
      timestamp: new Date().toISOString(),
      environment: env,
      reason: options.overrideReason,
      approver,
      metrics: input,
      originalBlocked: blocked,
    });

    return {
      decision: 'OVERRIDDEN_PERMIT',
      exitCode: 0,
      reasons: [
        `EMERGENCY OVERRIDE APPLIED by ${approver}: "${options.overrideReason}"`,
        ...reasons,
      ],
      metrics: input,
      environment: env,
      overrideApplied: true,
      overrideReason: options.overrideReason,
      overrideApprover: approver,
    };
  }

  if (blocked) {
    return {
      decision: 'BLOCK',
      exitCode: 1,
      reasons,
      metrics: input,
      environment: env,
    };
  }

  if (degraded) {
    return {
      decision: 'DEGRADED_PERMIT',
      exitCode: 0,
      reasons: [
        'Release permitted ONLY as reduced-traffic canary (<= 500 bps / 5%) with auto-promotion disabled',
        ...reasons,
      ],
      metrics: input,
      environment: env,
    };
  }

  return {
    decision: 'PERMIT',
    exitCode: 0,
    reasons: ['Error budget healthy and burn rates within safe operational limits'],
    metrics: input,
    environment: env,
  };
}

function recordOverrideAudit(record: Record<string, any>): void {
  try {
    const logsDir = path.resolve(__dirname, '../logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const auditFile = path.join(logsDir, 'slo-gate-overrides.jsonl');
    fs.appendFileSync(auditFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

async function queryPrometheus(baseUrl: string, expr: string): Promise<number | null> {
  const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(expr)}`;
  try {
    const res = await fetch(url);
    const json = (await res.json()) as any;
    const value = json?.data?.result?.[0]?.value?.[1];
    return value !== undefined ? parseFloat(value) : null;
  } catch {
    return null;
  }
}

export async function fetchLiveSloMetrics(prometheusUrl: string): Promise<SloEvaluationInput> {
  // Query 1h, 6h, 24h burn rates and budget consumption
  const q1h = 'sum(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[1h])) / sum(rate(http_requests_total{job="stellar-api"}[1h])) / 0.001';
  const q6h = 'sum(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[6h])) / sum(rate(http_requests_total{job="stellar-api"}[6h])) / 0.001';
  const q24h = 'sum(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[24h])) / sum(rate(http_requests_total{job="stellar-api"}[24h])) / 0.001';
  const qBudget = '100 - (sum_over_time(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[30d])[30d:1h]) / 0.001 * 100)';

  const [b1, b6, b24, budget] = await Promise.all([
    queryPrometheus(prometheusUrl, q1h),
    queryPrometheus(prometheusUrl, q6h),
    queryPrometheus(prometheusUrl, q24h),
    queryPrometheus(prometheusUrl, qBudget),
  ]);

  if (b1 === null && b6 === null && budget === null) {
    return {
      canonical1hBurnRate: 0,
      canonical6hBurnRate: 0,
      canonical24hBurnRate: 0,
      remainingBudgetPercent: 100,
      metricsAvailable: false,
    };
  }

  return {
    canonical1hBurnRate: b1 ?? 0,
    canonical6hBurnRate: b6 ?? 0,
    canonical24hBurnRate: b24 ?? 0,
    remainingBudgetPercent: budget ?? 100,
    metricsAvailable: true,
  };
}

export function formatGithubStepSummary(result: GateResult): string {
  const icon =
    result.decision === 'PERMIT'
      ? '✅'
      : result.decision === 'DEGRADED_PERMIT'
      ? '⚠️'
      : result.decision === 'OVERRIDDEN_PERMIT'
      ? '🚨'
      : '❌';

  return `
## ${icon} SLO Error-Budget Release Gate Decision: **${result.decision}**

- **Target Environment:** \`${result.environment}\`
- **Remaining 30d Budget:** \`${result.metrics.remainingBudgetPercent.toFixed(1)}%\`
- **1h Burn Rate:** \`${result.metrics.canonical1hBurnRate.toFixed(2)}x\`
- **6h Burn Rate:** \`${result.metrics.canonical6hBurnRate.toFixed(2)}x\`
- **24h Burn Rate:** \`${result.metrics.canonical24hBurnRate.toFixed(2)}x\`
${result.overrideApplied ? `- **Override Reason:** *${result.overrideReason}* (approved by ${result.overrideApprover})\n` : ''}
### Details & Findings
${result.reasons.map((r) => `- ${r}`).join('\n')}
`;
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const found = args.find((a) => a.startsWith(`--${flag}=`));
    return found ? found.split('=').slice(1).join('=') : undefined;
  };
  const hasFlag = (flag: string) => args.includes(`--${flag}`);

  const environment = getArg('environment') || process.env.DEPLOY_ENV || 'production';
  const prometheusUrl = getArg('prometheus-url') || process.env.PROMETHEUS_URL || 'http://localhost:9090';
  const overrideReason = getArg('override-reason') || process.env.SLO_OVERRIDE_REASON;
  const overrideApprover = getArg('override-approver') || process.env.SLO_OVERRIDE_APPROVER;
  const inputFile = getArg('input-metrics');
  const allowMetricsUnavailable = hasFlag('allow-metrics-unavailable') || process.env.SLO_ALLOW_METRICS_DOWN === 'true';

  let metrics: SloEvaluationInput;

  if (inputFile) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), inputFile), 'utf8');
    metrics = JSON.parse(raw);
  } else {
    metrics = await fetchLiveSloMetrics(prometheusUrl);
  }

  const result = evaluateSloGate(metrics, {
    environment,
    overrideReason,
    overrideApprover,
    allowMetricsUnavailable,
  });

  const summary = formatGithubStepSummary(result);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
    } catch (err) {
      console.error('Could not write to GITHUB_STEP_SUMMARY:', err);
    }
  }

  if (result.exitCode !== 0) {
    console.error(`\n[SLO GATE BLOCKED]: Release halted due to error-budget burn rate.`);
  }

  process.exit(result.exitCode);
}

// Run CLI if invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((err) => {
    console.error('Fatal error in SLO release gate:', err);
    process.exit(1);
  });
}
