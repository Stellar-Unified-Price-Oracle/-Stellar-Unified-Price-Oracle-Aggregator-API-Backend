import axios from 'axios';
import BigNumber from 'bignumber.js';
import { logger } from '../utils/logger';
import { NormalizedPrice, OracleSourceName, SourceHealthStatus } from '../types';
import { sourceCircuitBreaker } from '../source-circuit-breaker';
import {
  oracleSourceLatency,
  oracleSourceRequestsTotal,
  oracleSourceSlaBreaches,
  oracleApiCallsTotal,
  oracleApiCostTotal,
  oracleApiBudgetUtilization,
} from '../metrics';
import { estimateCostUsd, recordCall, getBudgetUtilization } from '../cost-model';

const SLA_THRESHOLD_SECONDS = 5;

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
    timestamp: number,
  ): NormalizedPrice {
    const bn = new BigNumber(rawPrice);
    const scaled = bn.multipliedBy(new BigNumber(10).pow(decimals));
    return {
      asset: asset.toUpperCase(),
      price: BigInt(scaled.toFixed(0)),
      decimals,
      source: this.name,
      timestamp,
    };
  }

  async fetchWithBackoff(asset: string, attempt = 1): Promise<NormalizedPrice | null> {
    if (!sourceCircuitBreaker.isAllowed(this.name)) {
      logger.warn(`[${this.name}] Circuit breaker OPEN — skipping fetch for ${asset}`);
      return null;
    }

    const maxAttempts = 3;
    const baseDelay = 1000;

    // #64: track request latency per source
    const timer = oracleSourceLatency.startTimer({ source: this.name, asset });

    // #65: record API call and update cost metrics
    oracleApiCallsTotal.inc({ source: this.name });
    recordCall(this.name);
    const costUsd = estimateCostUsd(this.name);
    if (costUsd > 0) oracleApiCostTotal.inc({ source: this.name }, costUsd);
    oracleApiBudgetUtilization.set({ source: this.name }, getBudgetUtilization(this.name));

    try {
      this.health.totalRequests++;
      const price = await this.fetchPrice(asset);

      const elapsed = timer({ status: 'success' });
      oracleSourceRequestsTotal.inc({ source: this.name, status: 'success' });
      if (elapsed > SLA_THRESHOLD_SECONDS) {
        oracleSourceSlaBreaches.inc({ source: this.name });
      }

      this.health.lastSuccess = Math.floor(Date.now() / 1000);
      this.health.consecutiveFailures = 0;
      this.health.healthy = true;
      sourceCircuitBreaker.recordSuccess(this.name);
      return price;
    } catch (err) {
      timer({ status: 'error' });
      oracleSourceRequestsTotal.inc({ source: this.name, status: 'error' });

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
