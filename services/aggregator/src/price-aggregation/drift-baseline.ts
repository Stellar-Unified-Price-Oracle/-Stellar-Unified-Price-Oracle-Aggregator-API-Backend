import { NormalizedPrice } from '../infrastructure/types';

export interface DriftBaseline {
  version: string;
  asset: string;
  source: string;
  windowStart: number;
  windowEnd: number;
  sampleCount: number;
  meanPrice: number;
  stdDevPrice: number;
  medianObservedAt: number | null;
  observedAtCoverage: number;
  medianReportingLagSeconds: number | null;
  decimals: number;
  createdAt: number;
}

export interface DriftComparison {
  asset: string;
  source: string;
  baselineVersion: string;
  currentMeanPrice: number;
  baselineMeanPrice: number;
  meanPriceChangePercent: number;
  currentStdDev: number;
  baselineStdDev: number;
  stdDevChangePercent: number;
  currentObservedAtCoverage: number;
  baselineObservedAtCoverage: number;
  observedAtCoverageChange: number;
  currentMedianReportingLagSeconds: number | null;
  baselineMedianReportingLagSeconds: number | null;
  reportingLagChangeSeconds: number | null;
  driftDetected: boolean;
  driftReasons: string[];
}

export class DriftBaselineStore {
  private baselines = new Map<string, DriftBaseline[]>();

  getBaseline(asset: string, source: string): DriftBaseline | undefined {
    const list = this.baselines.get(`${asset}:${source}`);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  getBaselines(asset: string, source: string): DriftBaseline[] {
    return this.baselines.get(`${asset}:${source}`) ?? [];
  }

  setBaseline(baseline: DriftBaseline): void {
    const key = `${baseline.asset}:${baseline.source}`;
    const list = this.baselines.get(key) ?? [];
    list.push(baseline);
    if (list.length > 5) list.shift();
    this.baselines.set(key, list);
  }

  allBaselines(): DriftBaseline[] {
    const result: DriftBaseline[] = [];
    for (const list of this.baselines.values()) result.push(...list);
    return result;
  }
}

export const driftBaselineStore = new DriftBaselineStore();

export function buildBaseline(
  version: string,
  asset: string,
  source: string,
  prices: NormalizedPrice[],
  decimals: number,
): DriftBaseline {
  const now = Math.floor(Date.now() / 1000);
  const validPrices = prices.filter((p) => p.asset === asset && p.source === source);
  const sampleCount = validPrices.length;
  let meanPrice = 0;
  let stdDevPrice = 0;
  let medianObservedAt: number | null = null;
  let observedAtCoverage = 0;
  let medianReportingLagSeconds: number | null = null;
  if (sampleCount > 0) {
    const values = validPrices.map((p) => Number(p.price));
    const sum = values.reduce((a, b) => a + b, 0);
    meanPrice = sum / sampleCount;
    const variance = values.reduce((a, b) => a + Math.pow(b - meanPrice, 2), 0) / sampleCount;
    stdDevPrice = Math.sqrt(variance);
    const observedAtList = validPrices
      .map((p) => p.observedAt)
      .filter((v): v is number => v !== null && v !== undefined);
    observedAtCoverage = observedAtList.length / sampleCount;
    if (observedAtList.length > 0) {
      const sorted = [...observedAtList].sort((a, b) => a - b);
      medianObservedAt = sorted[Math.floor(sorted.length / 2)];
    }
    const lags = validPrices
      .map((p) => p.observedAt !== null && p.observedAt !== undefined
        ? p.timestamp - p.observedAt!
        : null)
      .filter((v): v is number => v !== null);
    if (lags.length > 0) {
      const sortedLags = [...lags].sort((a, b) => a - b);
      medianReportingLagSeconds = sortedLags[Math.floor(sortedLags.length / 2)];
    }
  }
  const windowStart = validPrices.length > 0
    ? Math.min(...validPrices.map((p) => p.timestamp))
    : now;
  const windowEnd = validPrices.length > 0
    ? Math.max(...validPrices.map((p) => p.timestamp))
    : now;
  return {
    version,
    asset,
    source,
    windowStart,
    windowEnd,
    sampleCount,
    meanPrice,
    stdDevPrice,
    medianObservedAt,
    observedAtCoverage,
    medianReportingLagSeconds,
    decimals,
    createdAt: now,
  };
}

export function compareAgainstBaseline(
  asset: string,
  source: string,
  currentPrices: NormalizedPrice[],
  baseline: DriftBaseline,
): DriftComparison {
  const sampleCount = currentPrices.length;
  let currentMeanPrice = 0;
  let currentStdDev = 0;
  let currentObservedAtCoverage = 0;
  let currentMedianReportingLagSeconds: number | null = null;
  if (sampleCount > 0) {
    const values = currentPrices.map((p) => Number(p.price));
    const sum = values.reduce((a, b) => a + b, 0);
    currentMeanPrice = sum / sampleCount;
    const variance = values.reduce((a, b) => a + Math.pow(b - currentMeanPrice, 2), 0) / sampleCount;
    currentStdDev = Math.sqrt(variance);
    const observedAtList = currentPrices
      .map((p) => p.observedAt)
      .filter((v): v is number => v !== null && v !== undefined);
    currentObservedAtCoverage = observedAtList.length / sampleCount;
    const lags = currentPrices
      .map((p) => p.observedAt !== null && p.observedAt !== undefined
        ? p.timestamp - p.observedAt!
        : null)
      .filter((v): v is number => v !== null);
    if (lags.length > 0) {
      const sortedLags = [...lags].sort((a, b) => a - b);
      currentMedianReportingLagSeconds = sortedLags[Math.floor(sortedLags.length / 2)];
    }
  }
  const meanPriceChangePercent =
    baseline.meanPrice !== 0
      ? ((currentMeanPrice - baseline.meanPrice) / baseline.meanPrice) * 100
      : 0;
  const stdDevChangePercent =
    baseline.stdDevPrice !== 0
      ? ((currentStdDev - baseline.stdDevPrice) / baseline.stdDevPrice) * 100
      : 0;
  const observedAtCoverageChange = currentObservedAtCoverage - baseline.observedAtCoverage;
  const reportingLagChangeSeconds =
    currentMedianReportingLagSeconds !== null && baseline.medianReportingLagSeconds !== null
      ? currentMedianReportingLagSeconds - baseline.medianReportingLagSeconds
      : null;
  const driftReasons: string[] = [];
  const MEAN_PRICE_DRIFT_THRESHOLD = 5;
  const STD_DEV_DRIFT_THRESHOLD = 50;
  const OBSERVED_AT_COVERAGE_DRIFT_THRESHOLD = 0.2;
  const REPORTING_LAG_DRIFT_THRESHOLD = 300;
  if (Math.abs(meanPriceChangePercent) > MEAN_PRICE_DRIFT_THRESHOLD) {
    driftReasons.push(
      `mean price changed by ${meanPriceChangePercent.toFixed(1)}% (threshold: ${MEAN_PRICE_DRIFT_THRESHOLD}%)`,
    );
  }
  if (Math.abs(stdDevChangePercent) > STD_DEV_DRIFT_THRESHOLD) {
    driftReasons.push(
      `price volatility changed by ${stdDevChangePercent.toFixed(1)}% (threshold: ${STD_DEV_DRIFT_THRESHOLD}%)`,
    );
  }
  if (Math.abs(observedAtCoverageChange) > OBSERVED_AT_COVERAGE_DRIFT_THRESHOLD) {
    driftReasons.push(
      `observedAt coverage changed by ${(observedAtCoverageChange * 100).toFixed(1)}% (threshold: ${OBSERVED_AT_COVERAGE_DRIFT_THRESHOLD * 100}%)`,
    );
  }
  if (
    reportingLagChangeSeconds !== null &&
    Math.abs(reportingLagChangeSeconds) > REPORTING_LAG_DRIFT_THRESHOLD
  ) {
    driftReasons.push(
      `median reporting lag changed by ${reportingLagChangeSeconds}s (threshold: ${REPORTING_LAG_DRIFT_THRESHOLD}s)`,
    );
  }
  return {
    asset,
    source,
    baselineVersion: baseline.version,
    currentMeanPrice,
    baselineMeanPrice: baseline.meanPrice,
    meanPriceChangePercent,
    currentStdDev,
    baselineStdDev: baseline.stdDevPrice,
    stdDevChangePercent,
    currentObservedAtCoverage,
    baselineObservedAtCoverage: baseline.observedAtCoverage,
    observedAtCoverageChange,
    currentMedianReportingLagSeconds,
    baselineMedianReportingLagSeconds: baseline.medianReportingLagSeconds,
    reportingLagChangeSeconds,
    driftDetected: driftReasons.length > 0,
    driftReasons,
  };
}
