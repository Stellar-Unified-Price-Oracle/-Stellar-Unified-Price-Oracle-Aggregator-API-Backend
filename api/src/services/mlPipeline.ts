/**
 * mlPipeline.ts — Production ML Pipeline for Price Prediction
 *
 * Provides a PricePredictionService with:
 *  - Simple Moving Average baseline model
 *  - A/B model comparison (modelA vs modelB)
 *  - Drift metric logging
 *
 * Wire into the price feed route as an optional enrichment:
 *
 *   import { PricePredictionService } from './mlPipeline';
 *   const mlPipeline = PricePredictionService.create();
 *   // In route handler:
 *   const prediction = await mlPipeline.predict(assetPair, recentPrices);
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelConfig {
  /** Human-readable label for this model variant. */
  name: string;
  /** Window size for moving average (number of price ticks). */
  windowSize: number;
  /** Optional weight applied to recent observations (1 = uniform). */
  recencyBias: number;
}

export interface PriceTick {
  price: number;
  timestamp: number; // Unix ms
}

export interface PredictionResult {
  assetPair: string;
  predictedPrice: number;
  confidence: number; // 0–1
  modelUsed: string;
  latencyMs: number;
  generatedAt: number;
}

export interface ABComparisonResult {
  assetPair: string;
  modelA: PredictionResult;
  modelB: PredictionResult;
  winner: 'A' | 'B' | 'tie';
  /** Mean absolute error vs observed price (if supplied). */
  maeA?: number;
  maeB?: number;
}

export interface DriftMetrics {
  assetPair: string;
  windowSize: number;
  meanPrice: number;
  stdDev: number;
  driftScore: number; // 0 = no drift; higher = more drift
  observedAt: number;
}

// ---------------------------------------------------------------------------
// Baseline model implementations
// ---------------------------------------------------------------------------

/**
 * Simple Moving Average — equal-weight mean over the last `windowSize` ticks.
 */
function simpleMovingAverage(ticks: PriceTick[], windowSize: number): number {
  const window = ticks.slice(-windowSize);
  if (window.length === 0) return 0;
  const sum = window.reduce((acc, t) => acc + t.price, 0);
  return sum / window.length;
}

/**
 * Exponentially Weighted Moving Average — applies recencyBias as the decay factor.
 * Higher recencyBias (closer to 1) gives more weight to recent observations.
 */
function ewma(ticks: PriceTick[], windowSize: number, alpha: number): number {
  const window = ticks.slice(-windowSize);
  if (window.length === 0) return 0;
  let result = window[0].price;
  for (let i = 1; i < window.length; i++) {
    result = alpha * window[i].price + (1 - alpha) * result;
  }
  return result;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function mae(predicted: number, observed: number): number {
  return Math.abs(predicted - observed);
}

function confidenceScore(ticks: PriceTick[], predicted: number): number {
  if (ticks.length < 2) return 0.5;
  const prices = ticks.map((t) => t.price);
  const sd = stdDev(prices);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mean === 0) return 0.5;
  // Coefficient of variation: lower volatility → higher confidence
  const cv = sd / mean;
  return Math.max(0, Math.min(1, 1 - cv));
}

// ---------------------------------------------------------------------------
// PricePredictionService
// ---------------------------------------------------------------------------

export class PricePredictionService extends EventEmitter {
  private readonly modelA: ModelConfig;
  private readonly modelB: ModelConfig;

  /** In-memory price history keyed by asset pair. */
  private readonly history: Map<string, PriceTick[]> = new Map();

  /** Maximum history ticks to retain per pair. */
  private readonly maxHistoryLength: number;

  private constructor(modelA: ModelConfig, modelB: ModelConfig, maxHistoryLength = 500) {
    super();
    this.modelA = modelA;
    this.modelB = modelB;
    this.maxHistoryLength = maxHistoryLength;
  }

  /**
   * Factory — creates an instance with sensible production defaults.
   * Override by passing explicit configs.
   */
  static create(
    modelAConfig?: Partial<ModelConfig>,
    modelBConfig?: Partial<ModelConfig>
  ): PricePredictionService {
    const modelA: ModelConfig = {
      name: 'SMA-20',
      windowSize: 20,
      recencyBias: 1.0,
      ...modelAConfig,
    };
    const modelB: ModelConfig = {
      name: 'EWMA-20-0.15',
      windowSize: 20,
      recencyBias: 0.15, // alpha for EWMA
      ...modelBConfig,
    };
    return new PricePredictionService(modelA, modelB);
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Ingest a new price tick for an asset pair.
   * Call this every time a fresh price is received from an oracle.
   */
  ingest(assetPair: string, tick: PriceTick): void {
    const ticks = this.history.get(assetPair) ?? [];
    ticks.push(tick);
    if (ticks.length > this.maxHistoryLength) ticks.shift();
    this.history.set(assetPair, ticks);
    this.emitDriftMetrics(assetPair, ticks);
  }

  /**
   * Predict the next price for an asset pair using Model A (default).
   *
   * @param assetPair - e.g. 'XLM_USD'
   * @param externalTicks - optional override for history (e.g. from DB)
   */
  predict(assetPair: string, externalTicks?: PriceTick[]): PredictionResult {
    const t0 = Date.now();
    const ticks = externalTicks ?? this.history.get(assetPair) ?? [];
    const predictedPrice = this._runModel(this.modelA, ticks);
    const confidence = confidenceScore(ticks, predictedPrice);

    return {
      assetPair,
      predictedPrice,
      confidence,
      modelUsed: this.modelA.name,
      latencyMs: Date.now() - t0,
      generatedAt: Date.now(),
    };
  }

  /**
   * Run both models and compare their predictions.
   * If `observedPrice` is provided, compute MAE for each model.
   */
  compareModels(
    assetPair: string,
    observedPrice?: number,
    externalTicks?: PriceTick[]
  ): ABComparisonResult {
    const ticks = externalTicks ?? this.history.get(assetPair) ?? [];

    const t0A = Date.now();
    const predA = this._runModel(this.modelA, ticks);
    const latA = Date.now() - t0A;

    const t0B = Date.now();
    const predB = this._runModel(this.modelB, ticks);
    const latB = Date.now() - t0B;

    const confA = confidenceScore(ticks, predA);
    const confB = confidenceScore(ticks, predB);

    const modelAResult: PredictionResult = {
      assetPair,
      predictedPrice: predA,
      confidence: confA,
      modelUsed: this.modelA.name,
      latencyMs: latA,
      generatedAt: Date.now(),
    };

    const modelBResult: PredictionResult = {
      assetPair,
      predictedPrice: predB,
      confidence: confB,
      modelUsed: this.modelB.name,
      latencyMs: latB,
      generatedAt: Date.now(),
    };

    let maeA: number | undefined;
    let maeB: number | undefined;
    let winner: 'A' | 'B' | 'tie' = 'tie';

    if (observedPrice !== undefined) {
      maeA = mae(predA, observedPrice);
      maeB = mae(predB, observedPrice);
      if (maeA < maeB) winner = 'A';
      else if (maeB < maeA) winner = 'B';
    } else {
      // Without an observed price, prefer higher confidence
      if (confA > confB) winner = 'A';
      else if (confB > confA) winner = 'B';
    }

    const result: ABComparisonResult = {
      assetPair,
      modelA: modelAResult,
      modelB: modelBResult,
      winner,
      maeA,
      maeB,
    };

    this.emit('ab:comparison', result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _runModel(config: ModelConfig, ticks: PriceTick[]): number {
    if (config.recencyBias < 1) {
      return ewma(ticks, config.windowSize, config.recencyBias);
    }
    return simpleMovingAverage(ticks, config.windowSize);
  }

  private emitDriftMetrics(assetPair: string, ticks: PriceTick[]): void {
    const window = ticks.slice(-this.modelA.windowSize);
    if (window.length < 2) return;

    const prices = window.map((t) => t.price);
    const meanPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const sd = stdDev(prices);

    // Drift score: normalised standard deviation (coefficient of variation)
    const driftScore = meanPrice > 0 ? sd / meanPrice : 0;

    const metrics: DriftMetrics = {
      assetPair,
      windowSize: window.length,
      meanPrice,
      stdDev: sd,
      driftScore,
      observedAt: Date.now(),
    };

    this.emit('drift', metrics);

    if (driftScore > 0.05) {
      // Log significant drift (> 5% CV) for monitoring
      console.warn(
        `[MLPipeline] Drift alert for ${assetPair}: score=${driftScore.toFixed(4)}, ` +
        `mean=${meanPrice.toFixed(6)}, stdDev=${sd.toFixed(6)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton for use in route handlers
// ---------------------------------------------------------------------------

let _instance: PricePredictionService | null = null;

/**
 * Returns a shared PricePredictionService instance.
 * Create once at startup, reuse across request handlers.
 */
export function getPricePredictionService(): PricePredictionService {
  if (!_instance) {
    _instance = PricePredictionService.create();

    // Log drift metrics to stdout for Prometheus scraping / log aggregation
    _instance.on('drift', (m: DriftMetrics) => {
      console.info(
        `[MLPipeline:drift] pair=${m.assetPair} drift=${m.driftScore.toFixed(4)} ` +
        `mean=${m.meanPrice.toFixed(6)} stdDev=${m.stdDev.toFixed(6)}`
      );
    });

    _instance.on('ab:comparison', (r: ABComparisonResult) => {
      console.info(
        `[MLPipeline:ab] pair=${r.assetPair} winner=${r.winner} ` +
        `maeA=${r.maeA?.toFixed(6) ?? 'n/a'} maeB=${r.maeB?.toFixed(6) ?? 'n/a'}`
      );
    });
  }
  return _instance;
}
