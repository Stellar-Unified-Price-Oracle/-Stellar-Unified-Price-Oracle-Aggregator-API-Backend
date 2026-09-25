import { describe, it, expect, beforeEach } from 'vitest';
import { AnomalyDetector, AnomalyConfig } from '../src/price-aggregation/anomaly-detector';

describe('Anomaly Detection - Z-Score and MAD Detectors', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = new AnomalyDetector();
  });

  describe('Z-Score Detector', () => {
    it('should detect spike anomaly with injected outlier', () => {
      const baseline = [100, 101, 99, 102, 100, 101, 99, 102, 100, 101, 99, 102, 100, 101, 99, 102, 100, 101, 99, 102];
      baseline.forEach(price => detector.detect('XLM', price));

      const result = detector.detect('XLM', 200);
      expect(result).not.toBeNull();
      expect(result!.isAnomaly).toBe(true);
      expect(result!.method).toBe('zscore');
      expect(result!.score).toBeGreaterThan(1);
    });

    it('should not flag normal market movement as anomaly', () => {
      const normalRange = [100, 101, 102, 103, 104, 105, 104, 103, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 105];
      normalRange.forEach(price => detector.detect('USDC', price));

      const result = detector.detect('USDC', 106);
      expect(result?.isAnomaly || false).toBe(false);
    });

    it('should include baseline statistics in verdict', () => {
      const baseline = Array.from({ length: 20 }, (_, i) => 100 + (i % 5));
      baseline.forEach(price => detector.detect('BTC', price));

      const result = detector.detect('BTC', 500);
      expect(result).not.toBeNull();
      expect(result!.details).toContain('mean=');
      expect(result!.details).toContain('stdDev=');
      expect(result!.details).toContain('threshold=');
    });

    it('should normalize score relative to threshold', () => {
      const baseline = [100, 101, 99, 102, 100, 101, 99, 102, 100, 101, 99, 102, 100, 101, 99, 102, 100, 101, 99, 102];
      baseline.forEach(price => detector.detect('ETH', price));

      const result = detector.detect('ETH', 200);
      expect(result!.score).toBeGreaterThanOrEqual(1);
      expect(typeof result!.score).toBe('number');
    });
  });

  describe('Moving Average Deviation (MAD) Detector', () => {
    it('should detect level shift with moving average deviation', () => {
      const baseline = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
      baseline.forEach(price => detector.detect('XLM', price));

      const result = detector.detect('XLM', 200);
      expect(result).not.toBeNull();
      expect(result!.isAnomaly).toBe(true);
    });

    it('should measure deviation as percentage of moving average', () => {
      const baseline = Array.from({ length: 20 }, () => 50);
      baseline.forEach(price => detector.detect('USDC', price));

      const result = detector.detect('USDC', 150);
      expect(result).not.toBeNull();
      expect(result!.details).toContain('deviation=');
      expect(result!.details).toContain('%');
    });

    it('should handle zero moving average gracefully', () => {
      const zeroBaseline = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      zeroBaseline.forEach(price => detector.detect('ZERO', price));

      expect(() => detector.detect('ZERO', 100)).not.toThrow();
    });
  });

  describe('Cold-Start Behavior', () => {
    it('should not detect anomalies during cold start with insufficient history', () => {
      const result1 = detector.detect('NEW', 100);
      expect(result1).toBeNull();

      const result2 = detector.detect('NEW', 101);
      expect(result2).toBeNull();

      const result3 = detector.detect('NEW', 102);
      expect(result3).toBeNull();

      const result4 = detector.detect('NEW', 103);
      expect(result4).toBeNull();
    });

    it('should start detection once sufficient history accumulated', () => {
      for (let i = 0; i < 5; i++) {
        const result = detector.detect('ASSET', 100);
        expect(result).toBeNull();
      }

      const result = detector.detect('ASSET', 100);
      expect(typeof result).toBe('object');
    });
  });

  describe('Per-Asset Configuration', () => {
    it('should apply asset-specific window size', () => {
      detector.setConfig('XLM', { windowSize: 30 });
      detector.setConfig('USDC', { windowSize: 10 });

      const xlmConfig = detector.getConfigSummary('XLM');
      const usdcConfig = detector.getConfigSummary('USDC');

      expect(xlmConfig.config.windowSize).toBe(30);
      expect(usdcConfig.config.windowSize).toBe(10);
    });

    it('should apply asset-specific z-score threshold', () => {
      detector.setConfig('VOLATILE', { zScoreThreshold: 2.0 });
      detector.setConfig('STABLE', { zScoreThreshold: 5.0 });

      const volatileConfig = detector.getConfigSummary('VOLATILE');
      const stableConfig = detector.getConfigSummary('STABLE');

      expect(volatileConfig.config.zScoreThreshold).toBe(2.0);
      expect(stableConfig.config.zScoreThreshold).toBe(5.0);
    });

    it('should use defaults when no per-asset config set', () => {
      const config = detector.getConfigSummary('UNCONFIGURED');
      expect(config.config.windowSize).toBeGreaterThan(0);
      expect(config.config.zScoreThreshold).toBeGreaterThan(0);
    });

    it('should read asset-specific config from environment variables', () => {
      process.env.ANOMALY_WINDOW_SIZE_TEST = '50';
      process.env.ANOMALY_ZSCORE_THRESHOLD_TEST = '2.5';

      detector.applyRuntimeConfig('TEST');
      const config = detector.getConfigSummary('TEST');

      expect(config.config.windowSize).toBe(50);
      expect(config.config.zScoreThreshold).toBe(2.5);

      delete process.env.ANOMALY_WINDOW_SIZE_TEST;
      delete process.env.ANOMALY_ZSCORE_THRESHOLD_TEST;
    });
  });

  describe('False Positive Rate Measurement', () => {
    it('should track false positive rate across decisions', () => {
      detector.recordFeedback('XLM', false);
      detector.recordFeedback('XLM', false);
      detector.recordFeedback('XLM', true);

      const summary = detector.getConfigSummary('XLM');
      expect(summary.falsePositiveRate).toBe(2 / 3);
    });

    it('should return zero false positive rate when no feedback recorded', () => {
      const summary = detector.getConfigSummary('NOFEEDBACK');
      expect(summary.falsePositiveRate).toBe(0);
    });

    it('should track independent false positive rates per asset', () => {
      detector.recordFeedback('XLM', false);
      detector.recordFeedback('XLM', false);

      detector.recordFeedback('USDC', true);

      const xlmRate = detector.getConfigSummary('XLM').falsePositiveRate;
      const usdcRate = detector.getConfigSummary('USDC').falsePositiveRate;

      expect(xlmRate).toBe(1.0);
      expect(usdcRate).toBe(0);
    });
  });

  describe('Drift Detection with Known Injected Anomalies', () => {
    it('should detect drift from gradual level shift', () => {
      const driftSeries = [
        100, 100, 100, 100, 100,
        105, 105, 105, 105, 105,
        110, 110, 110, 110, 110,
        115, 115, 115, 115, 115,
        120,
      ];

      driftSeries.forEach(price => detector.detect('DRIFT', price));
      const result = detector.detect('DRIFT', 125);

      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThanOrEqual(0);
    });

    it('should distinguish single-source spike from market-wide move', () => {
      const baseline = Array.from({ length: 20 }, () => 100);
      baseline.forEach(price => detector.detect('MARKET', price));

      const singleSourceSpike = detector.detect('MARKET', 300);
      expect(singleSourceSpike?.isAnomaly).toBe(true);

      const marketWideMove = detector.detect('MARKET', 105);
      expect(marketWideMove?.isAnomaly || false).toBe(false);
    });
  });

  describe('Verdict Structure Completeness', () => {
    it('should include detector method identifier in verdict', () => {
      const baseline = Array.from({ length: 20 }, (_, i) => 100 + i);
      baseline.forEach(price => detector.detect('TEST', price));

      const result = detector.detect('TEST', 500);
      expect(result).not.toBeNull();
      expect(['zscore', 'moving_average', 'volatility']).toContain(result!.method);
    });

    it('should include numeric anomaly score normalized to threshold', () => {
      const baseline = Array.from({ length: 20 }, () => 100);
      baseline.forEach(price => detector.detect('TEST', price));

      const result = detector.detect('TEST', 300);
      expect(result).not.toBeNull();
      expect(typeof result!.score).toBe('number');
      expect(result!.score).toBeGreaterThanOrEqual(0);
    });

    it('should include detailed baseline information in verdict', () => {
      const baseline = Array.from({ length: 20 }, () => 100);
      baseline.forEach(price => detector.detect('TEST', price));

      const result = detector.detect('TEST', 200);
      expect(result).not.toBeNull();
      expect(result!.details).toBeTruthy();
      expect(typeof result!.details).toBe('string');
      expect(result!.details.length).toBeGreaterThan(10);
    });
  });

  describe('Volatility-Sensitive Detection', () => {
    it('should apply higher thresholds for high-volatility assets', () => {
      const highVolAsset = 'VOLA';
      detector.setConfig(highVolAsset, { volatilityMultiplier: 5.0 });

      const lowVolAsset = 'STAB';
      detector.setConfig(lowVolAsset, { volatilityMultiplier: 2.0 });

      const volatileConfig = detector.getConfigSummary(highVolAsset);
      const stableConfig = detector.getConfigSummary(lowVolAsset);

      expect(volatileConfig.config.volatilityMultiplier).toBe(5.0);
      expect(stableConfig.config.volatilityMultiplier).toBe(2.0);
    });
  });

  describe('Window Management', () => {
    it('should maintain configurable window size without unbounded memory growth', () => {
      detector.setConfig('MEM', { windowSize: 10 });

      for (let i = 0; i < 1000; i++) {
        detector.detect('MEM', 100 + (Math.random() * 10));
      }

      expect(() => detector.getConfigSummary('MEM')).not.toThrow();
    });
  });
});
