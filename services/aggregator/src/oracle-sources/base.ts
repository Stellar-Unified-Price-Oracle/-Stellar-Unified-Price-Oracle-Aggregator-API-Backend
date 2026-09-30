import BigNumber from 'bignumber.js';
import { logger } from '../observability/logger';
import { NormalizedPrice, OracleSourceName, SourceHealthStatus } from '../infrastructure/types';
import { sourceCircuitBreaker } from '../price-aggregation/source-circuit-breaker';
import { eventBus } from '../domain-events';
import {
  oracleSourceLatency,
  oracleSourceRequestsTotal,
  oracleSourceSlaBreaches,
  oracleSourceInvalidPayloadsTotal,
  oracleApiCallsTotal,
  oracleApiCostTotal,
  oracleApiBudgetUtilization,
} from '../observability/metrics';
import { estimateCostUsd, recordCall, getBudgetUtilization } from '../infrastructure/cost-model';
import { sanitizeAssetLabel, sanitizeSourceLabel } from '../observability/cardinality';
import {
  scaleValidatedPrice,
  type ProviderFetchResult,
} from './response-validation';
import AlertManager from '../observability/alert-manager';

const SLA_THRESHOLD_SECONDS = 5;

// Issue #584 — adapter-scoped invalid-payload alerter. A provider schema
// change must page, not degrade quietly; a shared instance keeps the
// per-source rate windows consistent across assets.
const invalidPayloadAlerter = new AlertManager({
  enableConsoleLog: true,
  enableFileLog: false,
});

export type SourceFailureKind = 'transport-error' | 'invalid-payload' | 'no-price';

export interface SourceFetchOutcome {
  price: NormalizedPrice | null;
  failureKind?: SourceFailureKind;
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

  /** Issue #584 — response schema this adapter validates against. */
  protected readonly schema?: string;

  /** Issue #584 — most recent payload-validation failure, for /health surfacing. */
  lastInvalidPayloadAt: number | null = null;

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

  /**
   * Records an adapter-level schema violation: counted, health-marked, and
   * (at a sustained rate) alerted (issue #584).
   */
  protected recordInvalidPayload(asset: string, issues: string): void {
    oracleSourceInvalidPayloadsTotal.inc({ source: sanitizeSourceLabel(this.name) });
    this.lastInvalidPayloadAt = Math.floor(Date.now() / 1000);
    void invalidPayloadAlerter.checkInvalidPayload(this.name, asset, issues);
  }

  /**
   * Normalizes a *validated* provider result. Non-finite or out-of-range
   * values are rejected before scaling (issue #584) instead of relying on
   * `BigInt` throwing.
   */
  protected normalizeValidated(
    asset: string,
    result: Extract<ProviderFetchResult, { kind: 'ok' }>,
  ): NormalizedPrice | null {
    const scaled = scaleValidatedPrice(result.price, result.decimals);
    if (!scaled.ok) {
      logger.error(`[${this.name}] Rejected ${asset} price before scaling: ${scaled.reason}`, {
        source: this.name,
        asset,
        price: String(result.price),
        decimals: result.decimals,
      });
      oracleSourceInvalidPayloadsTotal.inc({ source: sanitizeSourceLabel(this.name) });
      this.lastInvalidPayloadAt = Math.floor(Date.now() / 1000);
      void invalidPayloadAlerter.checkInvalidPayload(this.name, asset, scaled.reason);
      return null;
    }
    const fetchedAt = Math.floor(Date.now() / 1000);
    return {
      asset: asset.toUpperCase(),
      price: scaled.scaled,
      decimals: result.decimals,
      source: this.name,
      timestamp: result.observedAt ?? fetchedAt,
      observedAt: result.observedAt,
      fetchedAt,
    };
  }

  async fetchWithBackoff(asset: string, attempt = 1): Promise<NormalizedPrice | null> {
    const outcome = await this.fetchWithOutcome(asset, attempt);
    return outcome.price;
  }

  /**
   * Fetch with the full retry/health/circuit-breaker path, reporting *why* a
   * fetch produced no price: `transport-error`, `invalid-payload`, or
   * `no-price` (issue #584).
   */
  async fetchWithOutcome(asset: string, attempt = 1): Promise<SourceFetchOutcome> {
    if (!sourceCircuitBreaker.isAllowed(this.name)) {
      logger.warn(`[${this.name}] Circuit breaker OPEN — skipping fetch for ${asset}`);
      return { price: null, failureKind: 'transport-error' };
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
    oracleApiBudgetUtilization.set({ source: safeSource }, getBudgetUtilization(safeSource));

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
      return { price };
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
        return this.fetchWithOutcome(asset, attempt + 1);
      }

      logger.error(`[${this.name}] Failed to fetch ${asset} after ${maxAttempts} attempts`, err);
      return { price: null, failureKind: 'transport-error' };
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
