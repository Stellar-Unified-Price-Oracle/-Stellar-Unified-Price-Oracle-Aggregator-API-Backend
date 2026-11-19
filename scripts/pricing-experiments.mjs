#!/usr/bin/env node

/**
 * scripts/pricing-experiments.mjs — issue #796
 *
 * Validates pricing experiments against consumer safeguards (bounds, consent and
 * notice, cohort isolation, rollback triggers) and renders an auditable outcome
 * report to docs/PRICING_EXPERIMENT_SAFEGUARDS.md.
 *
 *   node scripts/pricing-experiments.mjs           # regenerate the report
 *   node scripts/pricing-experiments.mjs --check   # fail on violations or a stale report
 *   node scripts/pricing-experiments.mjs --json    # print the evaluation
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'pricing-experiments.json');
const reportPath = path.join(root, 'docs', 'PRICING_EXPERIMENT_SAFEGUARDS.md');

const BUCKETS = 10_000;
const DAY_MS = 86_400_000;
const INVERTED_LEVERS = new Set(['includedMonthlyRequests']);

function days(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

export function consumerCostChangePercent(exp) {
  if (!Number.isFinite(exp.controlValue) || exp.controlValue <= 0 || !Number.isFinite(exp.treatmentValue) || exp.treatmentValue < 0) {
    throw new Error(`Experiment ${exp.id}: controlValue must be > 0 and treatmentValue >= 0`);
  }
  const raw = ((exp.treatmentValue - exp.controlValue) / exp.controlValue) * 100;
  return Number((INVERTED_LEVERS.has(exp.lever) ? -raw : raw).toFixed(2));
}

export function bucketFor(apiKeyId, salt) {
  const digest = createHash('sha256').update(`${salt}:${apiKeyId}`).digest();
  return digest.readUInt32BE(0) % BUCKETS;
}

export function assignCohort(apiKeyId, exp, { excluded = false } = {}) {
  if (excluded) return 'excluded';
  const bucket = bucketFor(apiKeyId, exp.salt);
  const treatmentEnd = Math.round((exp.cohortPercent / 100) * BUCKETS);
  const holdoutEnd = treatmentEnd + Math.round((exp.holdoutPercent / 100) * BUCKETS);
  if (bucket < treatmentEnd) return 'treatment';
  if (bucket < holdoutEnd) return 'holdout';
  return 'control';
}

function overlaps(a, b) {
  return Date.parse(a.startDate) <= Date.parse(b.endDate) && Date.parse(b.startDate) <= Date.parse(a.endDate);
}

export function validateExperiment(policy, exp, others = []) {
  const v = [];
  const b = policy.bounds;
  const c = policy.consent;

  if (!exp.id || !exp.hypothesis) v.push('id and hypothesis are required');
  if (!b.eligibleTiers.includes(exp.tier)) v.push(`tier "${exp.tier}" is not eligible (allowed: ${b.eligibleTiers.join(', ')})`);
  if (!b.allowedLevers.includes(exp.lever)) v.push(`lever "${exp.lever}" is not allowed`);

  const touched = (exp.touchesGuarantees ?? []).filter((g) => b.protectedGuarantees.includes(g));
  if (touched.length > 0) v.push(`experiment must not vary protected guarantees: ${touched.join(', ')}`);

  let change = 0;
  try {
    change = consumerCostChangePercent(exp);
  } catch (err) {
    v.push(err.message);
  }
  if (change > b.maxPriceIncreasePercent) v.push(`consumer cost increase ${change}% exceeds ${b.maxPriceIncreasePercent}%`);
  if (-change > b.maxPriceDecreasePercent) v.push(`consumer cost decrease ${-change}% exceeds ${b.maxPriceDecreasePercent}%`);

  if (!(exp.cohortPercent > 0) || exp.cohortPercent > b.maxCohortPercentOfTier) {
    v.push(`cohortPercent ${exp.cohortPercent} must be in (0, ${b.maxCohortPercentOfTier}]`);
  }
  if (!(exp.holdoutPercent >= b.minHoldoutPercent)) v.push(`holdoutPercent ${exp.holdoutPercent} is below ${b.minHoldoutPercent}`);
  if (exp.cohortPercent + exp.holdoutPercent > 100) v.push('cohortPercent + holdoutPercent exceeds 100');
  const cohortKeys = Math.floor((exp.eligibleKeys ?? 0) * (exp.cohortPercent / 100));
  if (cohortKeys < b.minCohortKeys) v.push(`treatment cohort of ${cohortKeys} key(s) is below the minimum of ${b.minCohortKeys}`);

  const duration = days(exp.startDate, exp.endDate);
  if (!Number.isFinite(duration)) v.push('startDate and endDate must be ISO dates');
  else if (duration < b.minDurationDays || duration > b.maxDurationDays) {
    v.push(`duration ${duration}d must be within [${b.minDurationDays}, ${b.maxDurationDays}]`);
  }

  const requiredNotice = change > 0 ? c.priceIncreaseNoticeDays : c.priceDecreaseNoticeDays;
  const notice = exp.noticeSentAt ? days(exp.noticeSentAt, exp.startDate) : NaN;
  if (!Number.isFinite(notice) || notice < requiredNotice) {
    v.push(`notice of ${Number.isFinite(notice) ? notice : 'none'} day(s) is below the required ${requiredNotice}`);
  }
  if (change > c.explicitOptInAbovePercent && !exp.optIn) {
    v.push(`increase above ${c.explicitOptInAbovePercent}% requires explicit opt-in`);
  }
  if (!exp.salt) v.push('salt is required for sticky cohort assignment');

  const concurrent = others.filter((o) => o.id !== exp.id && o.tier === exp.tier && overlaps(o, exp));
  if (concurrent.length + 1 > b.maxActiveExperimentsPerTier) {
    v.push(`overlaps ${concurrent.map((o) => o.id).join(', ')} in tier ${exp.tier}; cohorts would not be isolated`);
  }

  return { valid: v.length === 0, violations: v, consumerCostChangePercent: change, cohortKeys, durationDays: duration, noticeDays: notice };
}

export function evaluateRollback(policy, observations = {}) {
  const tripped = [];
  const missing = [];
  for (const t of policy.rollbackTriggers) {
    const value = observations[t.metric];
    if (!Number.isFinite(value)) {
      missing.push(t.metric);
      continue;
    }
    const hit = t.comparison === 'gt' ? value > t.threshold : value < t.threshold;
    if (hit) tripped.push({ ...t, value });
  }
  return { rollback: tripped.length > 0, tripped, missing };
}

export function decide(validation, rollback) {
  if (!validation.valid) return 'REJECTED';
  if (rollback.rollback) return 'ROLLBACK';
  if (rollback.missing.length > 0) return 'INSUFFICIENT_EVIDENCE';
  return 'CONTINUE';
}

export function auditDigest(policy, exp) {
  const { observations, ...design } = exp;
  const payload = JSON.stringify({ bounds: policy.bounds, consent: policy.consent, triggers: policy.rollbackTriggers, design, observations });
  return createHash('sha256').update(payload).digest('hex');
}

export function evaluateAll(policy) {
  return policy.experiments.map((exp) => {
    const validation = validateExperiment(policy, exp, policy.experiments);
    const rollback = evaluateRollback(policy, exp.observations);
    return { id: exp.id, experiment: exp, validation, rollback, decision: decide(validation, rollback), digest: auditDigest(policy, exp) };
  });
}

function fmtValue(lever, value) {
  return lever === 'includedMonthlyRequests' ? value.toLocaleString('en-US') : `$${value}`;
}

export function renderReport(policy, results) {
  const b = policy.bounds;
  const c = policy.consent;
  const rows = results.map((r) => {
    const e = r.experiment;
    return `| \`${e.id}\` | ${e.tier} | \`${e.lever}\` ${fmtValue(e.lever, e.controlValue)} → ${fmtValue(e.lever, e.treatmentValue)} | ${r.validation.consumerCostChangePercent}% | ${e.cohortPercent}% / ${e.holdoutPercent}% | ${e.startDate} → ${e.endDate} | **${r.decision}** |`;
  });
  const details = results.map((r) => {
    const e = r.experiment;
    const triggerRows = policy.rollbackTriggers.map((t) => {
      const value = e.observations?.[t.metric];
      const hit = r.rollback.tripped.some((x) => x.metric === t.metric);
      return `| \`${t.metric}\` | ${t.comparison === 'gt' ? '>' : '<'} ${t.threshold} | ${Number.isFinite(value) ? value : 'missing'} | ${hit ? 'TRIPPED' : Number.isFinite(value) ? 'ok' : '—'} |`;
    });
    return `### \`${e.id}\`

- **Hypothesis**: ${e.hypothesis}
- **Validation**: ${r.validation.valid ? 'passes all safeguards' : r.validation.violations.map((x) => `\n  - ${x}`).join('')}
- **Treatment cohort**: ${r.validation.cohortKeys} key(s) of ${e.eligibleKeys}; notice ${r.validation.noticeDays} day(s); opt-in ${e.optIn ? 'required' : 'not required'}
- **Evidence**: ${e.observations?.label ?? 'measured observations'}
- **Audit digest (sha256)**: \`${r.digest}\`

| Rollback trigger | Fires when | Observed | Status |
| :--- | :--- | ---: | :--- |
${triggerRows.join('\n')}

**Decision: ${r.decision}**`;
  });

  return `# Pricing Experiment Safeguards (Issue #796)

Pricing experiments on the Service vary only commercial terms: base fee, overage
rate, or included requests. They never vary the data, rate limits, or service
levels a consumer receives. This document defines the bounds every experiment
must stay within. It's generated from \`config/pricing-experiments.json\` by
\`scripts/pricing-experiments.mjs\`, and \`npm run pricing-experiments:check\`
fails CI when an experiment breaks a safeguard or this file is stale.

## Owner and scope

- **Owner**: ${policy.owner} (${policy.workstream} workstream)
- **Approvers**: ${policy.approvers.join(', ')} (both must sign off before \`startDate\`)
- **In scope**: ${b.eligibleTiers.join(' and ')} tiers; levers ${b.allowedLevers.map((l) => `\`${l}\``).join(', ')}
- **Out of scope**: Enterprise contracts (negotiated rates) and keys tagged ${policy.cohortIsolation.excludeKeys.map((k) => `\`${k}\``).join(', ')}

## Experiment bounds

| Bound | Limit |
| :--- | :--- |
| Max consumer cost increase | ${b.maxPriceIncreasePercent}% |
| Max consumer cost decrease | ${b.maxPriceDecreasePercent}% |
| Treatment cohort | ≤ ${b.maxCohortPercentOfTier}% of tier, ≥ ${b.minCohortKeys} keys |
| Holdout | ≥ ${b.minHoldoutPercent}% |
| Duration | ${b.minDurationDays}–${b.maxDurationDays} days |
| Concurrent experiments per tier | ${b.maxActiveExperimentsPerTier} |
| Protected guarantees (never varied) | ${b.protectedGuarantees.map((g) => `\`${g}\``).join(', ')} |

Fewer included requests is treated as a price increase.

## Consent and notice

- Cost increases need **${c.priceIncreaseNoticeDays} days'** notice. Decreases need ${c.priceDecreaseNoticeDays}.
- Increases above **${c.explicitOptInAbovePercent}%** require explicit opt-in.
- Opt-out is ${c.optOutAlwaysAvailable ? 'always available and returns the key to control pricing at the next cycle' : 'not guaranteed'}.
- Notice goes out through ${c.noticeChannels.map((x) => `\`${x}\``).join(', ')}.
- **Billing protection**: ${c.billingProtection}

## Cohort isolation

- Assignment: \`${policy.cohortIsolation.assignment}\`. Buckets below the cohort share are treatment, the next band is holdout, and the rest is control.
- Assignment is ${policy.cohortIsolation.sticky ? 'sticky. A key stays in its cohort for the whole experiment' : 'not sticky'}.
- Experiments in the same tier may not overlap in time, so no key is ever in two treatments.

## Rollback triggers

Any one trigger firing rolls the treatment back to control pricing at the next
billing cycle, and the billing protection credits any excess.

| Metric | Fires when | Meaning |
| :--- | :--- | :--- |
${policy.rollbackTriggers.map((t) => `| \`${t.metric}\` | ${t.comparison === 'gt' ? '>' : '<'} ${t.threshold} | ${t.description} |`).join('\n')}

A missing metric yields \`INSUFFICIENT_EVIDENCE\`. An experiment can't be
declared successful without every metric.

## Experiment register and outcome report

| Experiment | Tier | Change | Cost Δ | Treatment / holdout | Window | Decision |
| :--- | :--- | :--- | ---: | :--- | :--- | :--- |
${rows.join('\n')}

${details.join('\n\n')}

## Compatibility, monitoring, and operational impact

- **Compatibility**: Offline policy tooling with no change to the API, the aggregator, or the contract. Rate limits and data paths are identical across cohorts by construction.
- **Monitoring**: Trigger metrics come from usage counters and billing reconciliation (\`npm run cost:reconcile\`), reviewed weekly while an experiment runs.
- **Operational impact**: None on the live price path.

## Rollout and rollback guidance

- **Rollout**: Add the experiment to \`config/pricing-experiments.json\`, run \`npm run pricing-experiments\`, and get both approvers' sign-off on the PR. Send notice, then start.
- **Rollback**: Set the treatment back to control pricing at the next billing cycle and credit any excess. Record the observations and commit the regenerated report as the audit record.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const policy = JSON.parse(await readFile(configPath, 'utf8'));
  const results = evaluateAll(policy);

  if (args.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const rendered = renderReport(policy, results);

  if (args.includes('--check')) {
    const rejected = results.filter((r) => r.decision === 'REJECTED');
    for (const r of rejected) console.error(`${r.id}: ${r.validation.violations.join('; ')}`);
    let existing = '';
    try {
      existing = await readFile(reportPath, 'utf8');
    } catch {}
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/PRICING_EXPERIMENT_SAFEGUARDS.md is stale. Run: npm run pricing-experiments');
      process.exit(1);
    }
    if (rejected.length > 0) process.exit(1);
    console.log(`Pricing experiment safeguards OK (${results.length} experiment(s)).`);
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, reportPath)}`);
  for (const r of results) console.log(`${r.id}: ${r.decision}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
