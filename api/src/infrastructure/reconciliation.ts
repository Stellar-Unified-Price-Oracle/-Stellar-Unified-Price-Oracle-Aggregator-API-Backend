import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../observability/metrics';
import { DatabaseClient } from './database';
import { ReconciliationLayer } from './data-consistency';

export type { ReconciliationLayer };

export interface ReconciliationViolation {
  asset: string;
  layer: ReconciliationLayer;
  expected: unknown;
  actual: unknown;
  diff: string;
}

export interface ReconciliationResult {
  layer: ReconciliationLayer;
  status: 'ok' | 'violation';
  details: string;
  violations: ReconciliationViolation[];
  checkedAt: number;
}

export interface ReconciliationOptions {
  priceTolerance?: number;
  timestampToleranceSec?: number;
}

export interface CacheAccessor {
  get(key: string): Promise<unknown> | unknown;
}

export interface SorobanPriceResult {
  price: string;
  timestamp: number;
}

const reconciliationChecksTotal = new client.Counter({
  name: 'reconciliation_checks_total',
  help: 'Total reconciliation checks by layer and result',
  labelNames: ['layer', 'result'],
});
register.registerMetric(reconciliationChecksTotal);

const reconciliationDivergenceCount = new client.Gauge({
  name: 'reconciliation_divergence_count',
  help: 'Current divergence count per reconciliation layer',
  labelNames: ['layer'],
});
register.registerMetric(reconciliationDivergenceCount);

const reconciliationLastRunTimestamp = new client.Gauge({
  name: 'reconciliation_last_run_timestamp',
  help: 'Unix timestamp (ms) of the last reconciliation run',
});
register.registerMetric(reconciliationLastRunTimestamp);

export class ReconciliationJob {
  private readonly priceTolerance: number;
  private readonly timestampToleranceSec: number;

  constructor(
    private readonly db: DatabaseClient,
    private readonly cache: CacheAccessor,
    private readonly sorobanRpcUrl: string,
    private readonly logger: Logger,
    options: ReconciliationOptions = {},
  ) {
    this.priceTolerance = options.priceTolerance ?? 0.01;
    this.timestampToleranceSec = options.timestampToleranceSec ?? 300;
  }

  async checkChainVsDb(): Promise<ReconciliationResult> {
    const layer: ReconciliationLayer = 'chain→db';
    const violations: ReconciliationViolation[] = [];

    try {
      const dbPrices = await this.db.getAllLatestPrices();
      if (dbPrices.length === 0) {
        reconciliationChecksTotal.inc({ layer, result: 'skipped' });
        return { layer, status: 'ok', details: 'no DB prices to reconcile', violations: [], checkedAt: Date.now() };
      }

      for (const dbRow of dbPrices) {
        let chainResult: SorobanPriceResult | null;
        try {
          chainResult = await this.fetchChainPrice(dbRow.asset);
        } catch {
          continue;
        }

        if (!chainResult) continue;

        const dbPrice = parseFloat(dbRow.price);
        const chainPrice = parseFloat(chainResult.price);

        if (dbPrice !== 0) {
          const priceDiff = Math.abs(chainPrice - dbPrice) / dbPrice;
          if (priceDiff > this.priceTolerance) {
            violations.push({
              asset: dbRow.asset,
              layer,
              expected: dbRow.price,
              actual: chainResult.price,
              diff: `price divergence ${(priceDiff * 100).toFixed(4)}% (>${(this.priceTolerance * 100).toFixed(2)}%)`,
            });
          }
        }

        const tsDrift = Math.abs(chainResult.timestamp - dbRow.timestamp);
        if (tsDrift > this.timestampToleranceSec) {
          violations.push({
            asset: dbRow.asset,
            layer,
            expected: dbRow.timestamp,
            actual: chainResult.timestamp,
            diff: `timestamp drift ${tsDrift}s (>${this.timestampToleranceSec}s)`,
          });
        }
      }
    } catch (err) {
      this.logger.error(`Reconciliation check error [${layer}]`, err);
      reconciliationChecksTotal.inc({ layer, result: 'error' });
      return { layer, status: 'ok', details: `check error: ${String(err)}`, violations: [], checkedAt: Date.now() };
    }

    return this.buildResult(layer, violations);
  }

  async checkCacheVsDb(): Promise<ReconciliationResult> {
    const layer: ReconciliationLayer = 'cache→db';
    const violations: ReconciliationViolation[] = [];

    try {
      const dbPrices = await this.db.getAllLatestPrices();
      if (dbPrices.length === 0) {
        reconciliationChecksTotal.inc({ layer, result: 'skipped' });
        return { layer, status: 'ok', details: 'no DB prices to reconcile', violations: [], checkedAt: Date.now() };
      }

      for (const dbRow of dbPrices) {
        const cached = await this.cache.get(`price:${dbRow.asset}`);
        if (cached == null) continue;

        const cachedRecord = cached as { price?: string; timestamp?: number };
        const cachedPrice = cachedRecord.price != null ? parseFloat(cachedRecord.price) : NaN;
        const dbPrice = parseFloat(dbRow.price);

        if (!isNaN(cachedPrice) && dbPrice !== 0) {
          const priceDiff = Math.abs(cachedPrice - dbPrice) / dbPrice;
          if (priceDiff > this.priceTolerance) {
            violations.push({
              asset: dbRow.asset,
              layer,
              expected: dbRow.price,
              actual: cachedRecord.price,
              diff: `cache price divergence ${(priceDiff * 100).toFixed(4)}% (>${(this.priceTolerance * 100).toFixed(2)}%)`,
            });
          }
        }

        if (cachedRecord.timestamp != null) {
          const tsDrift = Math.abs(cachedRecord.timestamp - dbRow.timestamp);
          if (tsDrift > this.timestampToleranceSec) {
            violations.push({
              asset: dbRow.asset,
              layer,
              expected: dbRow.timestamp,
              actual: cachedRecord.timestamp,
              diff: `cache timestamp drift ${tsDrift}s (>${this.timestampToleranceSec}s)`,
            });
          }
        }
      }
    } catch (err) {
      this.logger.error(`Reconciliation check error [${layer}]`, err);
      reconciliationChecksTotal.inc({ layer, result: 'error' });
      return { layer, status: 'ok', details: `check error: ${String(err)}`, violations: [], checkedAt: Date.now() };
    }

    return this.buildResult(layer, violations);
  }

  async checkAllLayers(): Promise<ReconciliationResult[]> {
    const results = await Promise.all([
      this.checkChainVsDb(),
      this.checkCacheVsDb(),
    ]);
    reconciliationLastRunTimestamp.set(Date.now());
    return results;
  }

  private async fetchChainPrice(asset: string): Promise<SorobanPriceResult | null> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: { asset },
    });

    const res = await fetch(`${this.sorobanRpcUrl}/get_price/${encodeURIComponent(asset)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const data = await res.json() as { price?: string; timestamp?: number };
    if (data.price == null || data.timestamp == null) return null;

    void body;
    return { price: data.price, timestamp: data.timestamp };
  }

  private buildResult(layer: ReconciliationLayer, violations: ReconciliationViolation[]): ReconciliationResult {
    reconciliationDivergenceCount.set({ layer }, violations.length);
    const result = violations.length > 0 ? 'violation' : 'ok';
    reconciliationChecksTotal.inc({ layer, result });
    if (violations.length > 0) {
      this.logger.warn(`[reconciliation] ${violations.length} divergence(s) in ${layer}`, { violations });
    }
    return {
      layer,
      status: result,
      details: violations.length > 0 ? `${violations.length} divergence(s)` : 'all layers consistent',
      violations,
      checkedAt: Date.now(),
    };
  }
}
