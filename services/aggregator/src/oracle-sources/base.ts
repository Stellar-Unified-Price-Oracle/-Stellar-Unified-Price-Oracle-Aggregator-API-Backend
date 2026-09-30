import BigNumber from 'bignumber.js';
import { logger } from '../observability/logger';
import { NormalizedPrice, OracleSourceName, SourceHealthStatus } from '../infrastructure/types';
import { sourceCircuitBreaker } from '../price-aggregation/source-circuit-breaker';
import { eventBus } from '../domain-events';
import {
  oracleSourceLatency,
  oracleSourceRequestsTotal,
  oracleSourceSlaBreaches,
  oracleSourceBudgetBlockedTotal,
  oracleApiCallsTotal,
  oracleApiCostTotal,
  oracleApiBudgetUtilization,
} from '../observability/metrics';
import {
  estimateCostUsd,
  recordCall,
  getBudgetStatus,
  BUDGET_WARN_RATIO,
} from '../infrastructure/cost-model';
import { sanitizeAssetLabel, sanitizeSourceLabel } from '../observability/cardinality';

const SLA_THRESHOLD_SECONDS = 5;

// #583 — throttled per-source budget warnings so a tight polling interval
// cannot flood the logs while the budget state lasts.
const budgetWarnTimestamps = new Map<string, number>();
const BUDGET_WARN_THROTTLE_MS = 60_000;

export function isBudgetBlocked(source: string): boolean {
  return getBudgetStatus(source).state === 'exhausted';
}

function warnBudgetExhausted(source: string): void {
  const now = Date.now();
  const last = budgetWarnTimestamps.get(`exhausted:${source}`) ?? 0;
  if (now - last >= BUDGET_WARN_THROTTLE_MS) {
    budgetWarnTimestamps.set(`exhausted:${source}`, now);
    logger.error(
      `[${source}] Daily API budget exhausted (utilization ≥ 100%) — source polling stopped until UTC rollover`,
    );
  }
}

function warnBudgetApproaching(source: string, utilization: number): void {
  const now = Date.now();
  const last = budgetWarnTimestamps.get(`warn:${source}`) ?? 0;
  if (now - last >= BUDGET_WARN_THROTTLE_MS) {
    budgetWarnTimestamps.set(`warn:${source}`, now);      logger.warn(
      `[${source}] Daily API budget ${(utilization * 100).toFixed(1)}% utilized (≥ ${BUDGET_WARN_RATIO * 100}%) — approaching exhaustion`,
    );
  }
}


export abstract class BaseSource {
  abstract name: OracleSourceName;
  abstract fetchPrice(asset: string): Promise<NormalizedPrice | null>;

  health: SourceHealthStatus = {
    healthy: true,
    lastSuccess: null,
    lastFailure: null,
    consecutiveFailures: 0,
    totalRequests: 0,
    totalFailures: 0,
    uptimePercent: 100,
  };

  private startedAt = Date.now();

  protected normalize(
    asset: string,
    rawPrice: string | number | BigNumber,
    decimals: number,
    observedAt: number | null,
  ): NormalizedPrice {
    const bn = new BigNumber(rawPrice);
    const scaled = bn.multipliedBy(new BigNumber(10).pow(decimals));
    const fetchedAt = Math.floor(Date.now() / 1000);
    return {
      asset: asset.toUpperCase(),
      price: BigInt(scaled.toFixed(0)),
      decimals,
      source: this.name,
      // Pass `null` when the provider reports no observation time. Stamping the
      // local fetch time into `timestamp` made every staleness check vacuous for
      // such a source, so the distinction is kept explicit instead.
      timestamp: observedAt ?? fetchedAt,
      observedAt,
      fetchedAt,
    };
  }

  async fetchWithBackoff(asset: string, attempt = 1): Promise<NormalizedPrice | null> {
    // #583 — a source whose daily budget is exhausted stops being polled. This
    // deliberately degrades aggregation quality (fewer sources → wider median
    // spread), so it is a loudly alerted state, not a silent skip.
    if (isBudgetBlocked(this.name)) {
      oracleSourceBudgetBlockedTotal.inc({ source: sanitizeSourceLabel(this.name) });
      logger.error(
        `[${this.name}] Daily API budget exhausted — skipping fetch for ${asset} until UTC rollover`,
      );
      return null;
    }

    if (!sourceCircuitBreaker.isAllowed(this.name)) {
      logger.warn(`[${this.name}] Circuit breaker OPEN — skipping fetch for ${asset}`);
      return null;
    }

    const maxAttempts = 3;
    const baseDelay = 1000;

    const safeAsset = sanitizeAssetLabel(asset);
    const safeSource = sanitizeSourceLabel(this.name);

    // #64: track request latency per source
    const timer = oracleSourceLatency.startTimer({ source: safeSource, asset: safeAsset });

    // #65: record API call and update cost metrics
    oracleApiCallsTotal.inc({ source: safeSource });
    recordCall(safeSource);
    const costUsd = estimateCostUsd(safeSource);
    if (costUsd > 0) oracleApiCostTotal.inc({ source: safeSource }, costUsd);
    const budgetStatus = getBudgetStatus(safeSource);
    oracleApiBudgetUtilization.set({ source: safeSource }, budgetStatus.utilization);
    // #583 — approaching/exceeding the budget is logged (throttled per source)
    // and mirrored into the Prometheus gauge; alerting rules fire off it.
    if (budgetStatus.state === 'exhausted') {
      warnBudgetExhausted(safeSource);
    } else if (budgetStatus.state === 'warn') {
      warnBudgetApproaching(safeSource, budgetStatus.utilization);
    }

    try {
      this.health.totalRequests++;
      const price = await this.fetchPrice(asset);

      const elapsed = timer({ status: 'success' });
      oracleSourceRequestsTotal.inc({ source: safeSource, status: 'success' });
      if (elapsed > SLA_THRESHOLD_SECONDS) {
        oracleSourceSlaBreaches.inc({ source: safeSource });
        eventBus.publish({
          type: 'sla_breach',
          payload: {
            source: this.name,
            asset,
            elapsedSeconds: elapsed,
            thresholdSeconds: SLA_THRESHOLD_SECONDS,
          },
          timestamp: Date.now(),
        });
      }

      this.health.lastSuccess = Math.floor(Date.now() / 1000);
      this.health.consecutiveFailures = 0;
      this.health.healthy = true;
      sourceCircuitBreaker.recordSuccess(this.name);
      return price;
    } catch (err) {
      timer({ status: 'error' });
      oracleSourceRequestsTotal.inc({ source: safeSource, status: 'error' });

      this.health.totalFailures++;
      this.health.lastFailure = Math.floor(Date.now() / 1000);
      this.health.consecutiveFailures++;

      if (this.health.consecutiveFailures >= 3) {
        this.health.healthy = false;
      }

      this.health.uptimePercent = this.calcUptime();
      sourceCircuitBreaker.recordFailure(this.name);

      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500, 10000);
        logger.warn(`[${this.name}] Retry ${asset} (attempt ${attempt}/${maxAttempts}) after ${delay}ms`, err);
        await new Promise(r => setTimeout(r, delay));
        return this.fetchWithBackoff(asset, attempt + 1);
      }

      logger.error(`[${this.name}] Failed to fetch ${asset} after ${maxAttempts} attempts`, err);
      return null;
    }
  }

  async fetchAll(assets: string[]): Promise<NormalizedPrice[]> {
    const results: NormalizedPrice[] = [];
    for (const asset of assets) {
      const price = await this.fetchWithBackoff(asset);
      if (price) results.push(price);
    }
    return results;
  }

  private calcUptime(): number {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed === 0) return 100;
    const failureRatio = this.health.totalFailures / Math.max(this.health.totalRequests, 1);
    return Math.round((1 - failureRatio) * 100);
  }
}
