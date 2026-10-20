import { createHash } from 'node:crypto';
import { FreshnessPolicy, freshnessPolicySchema, freshnessBudget, isFresh, realizedVolatility } from '../price-quality/freshness';
import { NormalizedPrice, AggregatedPrice, DegradationLevel } from '../infrastructure/types';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';
import { CircuitBreaker, CircuitBreakerConfig } from './circuit-breaker';
import { anomalyDetector } from './anomaly-detector';
import { medianOnCommonScale, isAgeVerified, toScale } from './median';

export interface AggregationEvidence {
  version: '1';
  id: string;
  asset: string;
  evaluatedAtMs: number;
  policy: { mode: 'legacy' | 'volatility-bounded'; budgetMs: number; hardMaxAgeMs: number | null; volatilityBps: number };
  observations: Array<{ source: string; price: string; decimals: number; observedAt: number | null;
    timestamp: number; normalizedPrice: string | null; included: boolean; reasons: string[] }>;
  quorum: { available: number; contributing: number; minimum: number; met: boolean };
  fallback: 'none' | 'stale' | 'suspicious';
  result: AggregatedPrice | null;
}

export class PriceAggregator {
  private sources: Map<string, NormalizedPrice> = new Map();
  private circuitBreaker: CircuitBreaker;

  private evidence = new Map<string, AggregationEvidence>();
  private previous = new Map<string, { price: string; timestamp: number; volatilityBps: number }>();
  private freshnessPolicy?: FreshnessPolicy;

  constructor(cbConfig?: CircuitBreakerConfig, freshnessPolicy?: FreshnessPolicy) {
    this.freshnessPolicy = freshnessPolicy !== undefined ? freshnessPolicySchema.parse(freshnessPolicy) : undefined;
    const circuitBreakerConfig: CircuitBreakerConfig = {
      deviationThreshold: 20, // 20% deviation threshold
      recoveryRequiredSuccesses: 3, // 3 consecutive successes to recover
      ...cbConfig,
    };
    this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
  }

  updateSourcePrice(price: NormalizedPrice): void {
    const key = `${price.source}:${price.asset}`;
    this.sources.set(key, price);

    // Evaluate with circuit breaker
    const allPrices = Array.from(this.sources.values());
    const evaluation = this.circuitBreaker.evaluatePrice(price, allPrices);

    if (evaluation.isSuspicious) {
      logger.warn(
        `Source ${price.source} is suspicious for ${price.asset} (deviation: ${evaluation.deviation.toFixed(2)}%)`,
      );
    }
  }

  getLatestForAsset(asset: string): AggregatedPrice | null {
    const normalized = asset.toUpperCase();
    const prices = Array.from(this.sources.values())
      .filter((p) => p.asset === normalized);

    if (prices.length === 0) return null;

    const nowMs = Date.now();
    const totalSources = prices.length;
    const previous = this.previous.get(normalized);
    const volatilityBps = previous?.volatilityBps ?? 0;
    const budgetMs = this.freshnessPolicy ? freshnessBudget(this.freshnessPolicy, volatilityBps) : config.stalenessThresholdMs;
    const validPrices = prices.filter(p => this.freshnessPolicy
      ? isFresh(p.observedAt, nowMs, budgetMs)
      : nowMs - p.timestamp * 1000 < budgetMs);
    const stale = validPrices.length === 0;
    const activePrices = stale && !this.freshnessPolicy ? prices : validPrices;
    const suspicious = (p: NormalizedPrice) => this.circuitBreaker.getSourceState(`${p.asset}:${p.source}`)?.suspicious === true;
    const trustedPrices = activePrices.filter(p => !suspicious(p));
    const pricesToUse = trustedPrices.length > 0 ? trustedPrices : this.freshnessPolicy ? [] : activePrices;
    const fallback = stale && !this.freshnessPolicy ? 'stale'
      : trustedPrices.length === 0 && pricesToUse.length > 0 ? 'suspicious' : 'none';
    const capture = (result: AggregatedPrice | null) => {
      const content = {
        version: '1' as const, asset: normalized, evaluatedAtMs: nowMs,
        policy: { mode: this.freshnessPolicy ? 'volatility-bounded' as const : 'legacy' as const,
          budgetMs, hardMaxAgeMs: this.freshnessPolicy?.hardMaxAgeMs ?? null, volatilityBps },
        observations: prices.map(p => ({ source: p.source, price: p.price.toString(), decimals: p.decimals,
          observedAt: p.observedAt ?? null, timestamp: p.timestamp,
          normalizedPrice: result ? toScale(p, result.decimals).toFixed() : null,
          included: pricesToUse.includes(p), reasons: [
            ...(!validPrices.includes(p) ? ['outside-freshness-policy'] : []),
            ...(p.observedAt == null ? ['unverified-observation-time'] : []),
            ...(suspicious(p) ? ['suspicious'] : []),
          ] })),
        quorum: { available: totalSources, contributing: pricesToUse.length, minimum: 1, met: pricesToUse.length >= 1 },
        fallback, result,
      };
      const id = createHash('sha256').update(JSON.stringify(content)).digest('hex');
      this.evidence.set(normalized, structuredClone({ ...content, id }));
    };
    if (pricesToUse.length === 0) { capture(null); return null; }

    const { value: median, decimals } = medianOnCommonScale(pricesToUse);
    const sources = Array.from(new Set(pricesToUse.map((p) => p.source)));
    const confidence = pricesToUse.length / Math.max(totalSources, 1);

    const degradationLevel = this.computeDegradationLevel(pricesToUse.length, totalSources, stale);

    const medianFloat = parseFloat(median.toString()) / Math.pow(10, decimals);
    const anomaly = anomalyDetector.detect(normalized, medianFloat) ?? undefined;

    const result: AggregatedPrice = {
      asset: normalized,
      price: median.toString(),
      // The median is computed on a common scale, so it must be reported with
      // the scale it was computed on — not with the first source's decimals,
      // which only matched by coincidence when every source agreed.
      decimals,
      sources,
      timestamp: Math.floor(nowMs / 1000),
      confidence,
      degradationLevel,
      stale,
      ageVerified: isAgeVerified(pricesToUse),
      anomaly,
    };
    const latestObservation = Math.max(...pricesToUse.map(p => p.observedAt ?? p.timestamp));
    const humanPrice = median.shiftedBy(-decimals).toFixed();
    if (median.gt(0) && (!previous || latestObservation > previous.timestamp)) {
      this.previous.set(normalized, { price: humanPrice, timestamp: latestObservation,
        volatilityBps: previous ? realizedVolatility(previous.price, humanPrice) : 0 });
    }
    capture(result);
    return result;
  }

  getEvidence(asset: string): AggregationEvidence | null {
    const bundle = this.evidence.get(asset.toUpperCase());
    return bundle ? structuredClone(bundle) : null;
  }

  private computeDegradationLevel(activeCount: number, totalCount: number, stale: boolean): DegradationLevel {
    if (stale || activeCount === 0) return 'critical';
    const ratio = activeCount / Math.max(totalCount, 1);
    if (ratio < 0.5) return 'critical';
    if (ratio < 1.0) return 'degraded';
    return 'healthy';
  }

  getAllPrices(): AggregatedPrice[] {
    const assets = Array.from(
      new Set(Array.from(this.sources.values()).map((p) => p.asset)),
    );
    return assets
      .map((asset) => this.getLatestForAsset(asset))
      .filter((p): p is AggregatedPrice => p !== null);
  }

  getSourceCount(): number {
    return Array.from(
      new Set(Array.from(this.sources.values()).map((p) => p.source)),
    ).length;
  }

  getCircuitBreakerMetrics() {
    return this.circuitBreaker.getMetrics();
  }

  getSuspiciousSources() {
    return this.circuitBreaker.getSuspiciousSources();
  }

  resetCircuitBreaker(sourceKey?: string) {
    if (sourceKey) {
      this.circuitBreaker.resetSource(sourceKey);
    } else {
      this.circuitBreaker.resetAll();
    }
  }
}
