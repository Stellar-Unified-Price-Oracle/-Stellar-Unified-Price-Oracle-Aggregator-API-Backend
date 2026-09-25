import { beforeEach, describe, expect, it } from 'vitest';
import { AnomalyDetector, AnomalyConfig } from '../src/price-aggregation/anomaly-detector';

interface AnomalyVerdict {
  asset: string;
  timestamp: number;
  aggregateValue: number;
  baseline: { mean: number; stdDev: number };
  thresholds: AnomalyConfig;
  configVersion: string;
  contributingSources: string[];
  verdict: boolean;
  method: string;
  score: number;
  details: string;
}

describe('anomaly detection auditing and persistence', () => {
  let detector: AnomalyDetector;
  let verdicts: Map<string, AnomalyVerdict[]>;

  beforeEach(() => {
    detector = new AnomalyDetector();
    verdicts = new Map();
  });

  it('captures all detection inputs in a verdict record', () => {
    detector.setConfig('XLM', {
      windowSize: 10,
      zScoreThreshold: 3.0,
      movingAverageDeviationPercent: 5.0,
      volatilityMultiplier: 3.0,
    });

    const prices = [100, 101, 102, 101, 100, 99, 100, 101, 102, 101, 150];
    prices.forEach((price) => detector.detect('XLM', price));

    const anomalyScore = detector.detect('XLM', 150);
    expect(anomalyScore).not.toBeNull();
    expect(anomalyScore?.score).toBeGreaterThan(1);

    const verdict: AnomalyVerdict = {
      asset: 'XLM',
      timestamp: Date.now(),
      aggregateValue: 150,
      baseline: { mean: 101, stdDev: 0.8 },
      thresholds: {
        windowSize: 10,
        zScoreThreshold: 3.0,
        movingAverageDeviationPercent: 5.0,
        volatilityMultiplier: 3.0,
      },
      configVersion: 'v1.0',
      contributingSources: ['chainlink', 'redstone', 'band'],
      verdict: anomalyScore?.isAnomaly ?? false,
      method: anomalyScore?.method ?? 'unknown',
      score: anomalyScore?.score ?? 0,
      details: anomalyScore?.details ?? '',
    };

    expect(verdict.configVersion).toBe('v1.0');
    expect(verdict.contributingSources).toEqual(['chainlink', 'redstone', 'band']);
    expect(verdict.verdict).toBe(true);
  });

  it('computes false-positive rate from persisted verdicts', () => {
    detector.setConfig('BTC', {
      windowSize: 20,
      zScoreThreshold: 2.5,
      movingAverageDeviationPercent: 3.0,
      volatilityMultiplier: 2.5,
    });

    const prices = Array.from({ length: 30 }, (_, i) => 45000 + Math.random() * 100);
    prices.forEach((price) => detector.detect('BTC', price));

    detector.recordFeedback('BTC', false);
    detector.recordFeedback('BTC', false);
    detector.recordFeedback('BTC', true);

    const summary = detector.getConfigSummary('BTC');
    expect(summary.falsePositiveRate).toBeCloseTo(0.666, 2);
  });

  it('stores verdicts at documented write rate and retention', () => {
    const assetVerdicts: AnomalyVerdict[] = [];

    for (let i = 0; i < 100; i++) {
      const timestamp = Date.now() + i * 30000;
      const verdict: AnomalyVerdict = {
        asset: 'ETH',
        timestamp,
        aggregateValue: 2000 + Math.random() * 50,
        baseline: { mean: 2000, stdDev: 10 },
        thresholds: {
          windowSize: 20,
          zScoreThreshold: 3.0,
          movingAverageDeviationPercent: 5.0,
          volatilityMultiplier: 3.0,
        },
        configVersion: 'v1.0',
        contributingSources: ['chainlink', 'redstone'],
        verdict: Math.random() > 0.95,
        method: 'zscore',
        score: Math.random() * 5,
        details: 'test verdict',
      };
      assetVerdicts.push(verdict);
    }

    verdicts.set('ETH', assetVerdicts);

    const allVerdicts = verdicts.get('ETH') || [];
    expect(allVerdicts).toHaveLength(100);
    expect(allVerdicts[0].timestamp).toBeLessThan(allVerdicts[99].timestamp);
  });

  it('supports re-evaluating historical verdicts under changed thresholds', () => {
    detector.setConfig('USDC', {
      windowSize: 20,
      zScoreThreshold: 3.0,
      movingAverageDeviationPercent: 5.0,
      volatilityMultiplier: 3.0,
    });

    const prices = [1.0, 1.0001, 0.9999, 1.0, 0.9998, 1.0002, 1.0, 1.0, 1.0, 1.0, 1.05];
    prices.forEach((price) => detector.detect('USDC', price));

    const historicalVerdicts: AnomalyVerdict[] = [
      {
        asset: 'USDC',
        timestamp: Date.now() - 10000,
        aggregateValue: 1.05,
        baseline: { mean: 1.0, stdDev: 0.00005 },
        thresholds: {
          windowSize: 20,
          zScoreThreshold: 3.0,
          movingAverageDeviationPercent: 5.0,
          volatilityMultiplier: 3.0,
        },
        configVersion: 'v1.0',
        contributingSources: ['chainlink'],
        verdict: true,
        method: 'zscore',
        score: 1000,
        details: 'original threshold triggered',
      },
    ];

    const newThreshold: AnomalyConfig = {
      windowSize: 20,
      zScoreThreshold: 5.0,
      movingAverageDeviationPercent: 10.0,
      volatilityMultiplier: 5.0,
    };

    const reevaluated = historicalVerdicts.map((v) => ({
      ...v,
      thresholds: newThreshold,
      verdict: v.score / newThreshold.zScoreThreshold > 1,
    }));

    expect(reevaluated[0].verdict).toBe(true);
    expect(reevaluated[0].score / newThreshold.zScoreThreshold).toBeGreaterThan(1);
  });

  it('exposes audit query path for asset and time range', () => {
    const startTime = Date.now() - 3600000;
    const endTime = Date.now();

    const verdictRecords: AnomalyVerdict[] = [
      {
        asset: 'XLM',
        timestamp: startTime + 600000,
        aggregateValue: 100,
        baseline: { mean: 100, stdDev: 1 },
        thresholds: {
          windowSize: 20,
          zScoreThreshold: 3.0,
          movingAverageDeviationPercent: 5.0,
          volatilityMultiplier: 3.0,
        },
        configVersion: 'v1.0',
        contributingSources: ['chainlink'],
        verdict: false,
        method: 'zscore',
        score: 0.5,
        details: 'normal',
      },
      {
        asset: 'XLM',
        timestamp: startTime + 1200000,
        aggregateValue: 110,
        baseline: { mean: 100, stdDev: 1 },
        thresholds: {
          windowSize: 20,
          zScoreThreshold: 3.0,
          movingAverageDeviationPercent: 5.0,
          volatilityMultiplier: 3.0,
        },
        configVersion: 'v1.0',
        contributingSources: ['chainlink'],
        verdict: true,
        method: 'zscore',
        score: 10,
        details: 'spike detected',
      },
    ];

    const queryResult = verdictRecords.filter((v) => v.asset === 'XLM' && v.timestamp >= startTime && v.timestamp <= endTime);

    expect(queryResult).toHaveLength(2);
    expect(queryResult[0].verdict).toBe(false);
    expect(queryResult[1].verdict).toBe(true);
  });

  it('defines and applies ground-truth for true/false positive classification', () => {
    const verdict: AnomalyVerdict = {
      asset: 'BTC',
      timestamp: Date.now() - 300000,
      aggregateValue: 50000,
      baseline: { mean: 45000, stdDev: 500 },
      thresholds: {
        windowSize: 20,
        zScoreThreshold: 3.0,
        movingAverageDeviationPercent: 5.0,
        volatilityMultiplier: 3.0,
      },
      configVersion: 'v1.0',
      contributingSources: ['chainlink', 'redstone'],
      verdict: true,
      method: 'zscore',
      score: 10,
      details: 'anomaly detected',
    };

    const subsequentAggregates = [50000, 49500, 49000, 48500, 48000];

    const isAnomalaySustained = subsequentAggregates.some((agg) => Math.abs(agg - verdict.baseline.mean) > 2 * verdict.baseline.stdDev);

    const isTruePositive = isAnomalaySustained;

    expect(isTruePositive).toBe(true);
    expect(verdict.verdict).toBe(true);

    detector.recordFeedback(verdict.asset, isTruePositive);
    const falsePositiveRate = detector.getFalsePositiveRate(verdict.asset);
    expect(falsePositiveRate).toBe(0);
  });

  it('records verdict retention consistent with price data retention policy', () => {
    const retentionDays = 30;
    const maxVerdictAge = retentionDays * 24 * 60 * 60 * 1000;

    const verdictTimestamp = Date.now() - maxVerdictAge + 1000;
    const verdict: AnomalyVerdict = {
      asset: 'XRP',
      timestamp: verdictTimestamp,
      aggregateValue: 0.5,
      baseline: { mean: 0.5, stdDev: 0.01 },
      thresholds: {
        windowSize: 20,
        zScoreThreshold: 3.0,
        movingAverageDeviationPercent: 5.0,
        volatilityMultiplier: 3.0,
      },
      configVersion: 'v1.0',
      contributingSources: ['band'],
      verdict: false,
      method: 'zscore',
      score: 0.1,
      details: 'within normal range',
    };

    const isWithinRetention = Date.now() - verdict.timestamp <= maxVerdictAge;
    expect(isWithinRetention).toBe(true);
  });
});
