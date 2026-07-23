import { AnomalyScore } from '../infrastructure/types';
import { logger } from '../observability/logger';

export interface AnomalyConfig {
  windowSize: number;
  zScoreThreshold: number;
  movingAverageDeviationPercent: number;
  volatilityMultiplier: number;
}

const DEFAULT_CONFIG: AnomalyConfig = {
  windowSize: 20,
  zScoreThreshold: 3.0,
  movingAverageDeviationPercent: 5.0,
  volatilityMultiplier: 3.0,
};

export class AnomalyDetector {
  private priceHistory: Map<string, number[]> = new Map();
  private configs: Map<string, AnomalyConfig> = new Map();
  private falsePositives: Map<string, number> = new Map();
  private trueAnomalies: Map<string, number> = new Map();

  setConfig(asset: string, config: Partial<AnomalyConfig>): void {
    this.configs.set(asset, { ...DEFAULT_CONFIG, ...config });
  }

  private getConfig(asset: string): AnomalyConfig {
    return this.configs.get(asset) ?? DEFAULT_CONFIG;
  }

  recordFeedback(asset: string, isTrueAnomaly: boolean): void {
    if (isTrueAnomaly) {
      this.trueAnomalies.set(asset, (this.trueAnomalies.get(asset) ?? 0) + 1);
    } else {
      this.falsePositives.set(asset, (this.falsePositives.get(asset) ?? 0) + 1);
    }
  }

  getFalsePositiveRate(asset: string): number {
    const fp = this.falsePositives.get(asset) ?? 0;
    const tp = this.trueAnomalies.get(asset) ?? 0;
    const total = fp + tp;
    return total === 0 ? 0 : fp / total;
  }

  detect(asset: string, currentPrice: number): AnomalyScore | null {
    const history = this.priceHistory.get(asset) ?? [];

    if (history.length < 5) {
      history.push(currentPrice);
      this.priceHistory.set(asset, history);
      return null;
    }

    const config = this.getConfig(asset);
    const window = history.slice(-config.windowSize);

    const zResult = this.detectZScore(currentPrice, window, config.zScoreThreshold);
    const maResult = this.detectMovingAverageDeviation(currentPrice, window, config.movingAverageDeviationPercent);
    const volResult = this.detectVolatility(currentPrice, window, config.volatilityMultiplier);

    history.push(currentPrice);
    if (history.length > config.windowSize * 2) {
      history.shift();
    }
    this.priceHistory.set(asset, history);

    const detections = [zResult, maResult, volResult].filter((r): r is AnomalyScore => r !== null);
    if (detections.length === 0) return null;

    const anomalyDetections = detections.filter((d) => d.isAnomaly);
    if (anomalyDetections.length === 0) return null;

    const highest = anomalyDetections.reduce((a, b) => (a.score > b.score ? a : b));
    logger.warn(`[AnomalyDetector] ${asset}: anomaly detected via ${highest.method} (score=${highest.score.toFixed(3)}) — ${highest.details}`);
    return highest;
  }

  private detectZScore(price: number, window: number[], threshold: number): AnomalyScore {
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / window.length;
    const stdDev = Math.sqrt(variance);
    const z = stdDev === 0 ? 0 : Math.abs((price - mean) / stdDev);
    return {
      isAnomaly: z > threshold,
      score: z / threshold,
      method: 'zscore',
      details: `z=${z.toFixed(3)}, mean=${mean.toFixed(6)}, stdDev=${stdDev.toFixed(6)}, threshold=${threshold}`,
    };
  }

  private detectMovingAverageDeviation(price: number, window: number[], thresholdPercent: number): AnomalyScore {
    const ma = window.reduce((a, b) => a + b, 0) / window.length;
    const deviationPercent = ma === 0 ? 0 : (Math.abs(price - ma) / ma) * 100;
    return {
      isAnomaly: deviationPercent > thresholdPercent,
      score: deviationPercent / thresholdPercent,
      method: 'moving_average',
      details: `deviation=${deviationPercent.toFixed(2)}%, ma=${ma.toFixed(6)}, threshold=${thresholdPercent}%`,
    };
  }

  private detectVolatility(price: number, window: number[], multiplier: number): AnomalyScore {
    if (window.length < 2) return { isAnomaly: false, score: 0, method: 'volatility', details: 'insufficient data' };

    const returns: number[] = [];
    for (let i = 1; i < window.length; i++) {
      if (window[i - 1] !== 0) {
        returns.push((window[i] - window[i - 1]) / window[i - 1]);
      }
    }
    if (returns.length === 0) return { isAnomaly: false, score: 0, method: 'volatility', details: 'no valid returns' };

    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
    const vol = Math.sqrt(variance);
    const last = window[window.length - 1];
    const currentReturn = last === 0 ? 0 : Math.abs((price - last) / last);
    const threshold = vol * multiplier;
    const score = threshold === 0 ? 0 : currentReturn / threshold;

    return {
      isAnomaly: currentReturn > threshold,
      score,
      method: 'volatility',
      details: `return=${(currentReturn * 100).toFixed(3)}%, vol=${(vol * 100).toFixed(3)}%, threshold=${(threshold * 100).toFixed(3)}%`,
    };
  }
}

export const anomalyDetector = new AnomalyDetector();
