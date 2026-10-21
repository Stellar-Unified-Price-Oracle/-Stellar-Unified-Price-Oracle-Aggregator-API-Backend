import { NormalizedPrice } from '../infrastructure/types';
import { OracleSourceName } from '@stellar-oracle/types';
import {
  driftBaselineStore,
  buildBaseline,
  compareAgainstBaseline,
  type DriftBaseline,
  type DriftComparison,
} from './drift-baseline';

export interface DriftDetectionResult {
  asset: string;
  comparisons: DriftComparison[];
  anyDrift: boolean;
}

/**
 * DriftDetector evaluates per-source price distributions against versioned
 * baselines to detect semantic drift in provider field meaning, timestamp
 * behavior, and value distributions.
 */
export class DriftDetector {
  private baselinesByAsset = new Map<string, DriftBaseline[]>();
  private detectionHistory = new Map<string, DriftComparison[]>();

  /**
   * Establish or refresh a baseline from a window of historical prices.
   * Call this periodically (e.g. daily) or after a known-good deployment.
   */
  establishBaseline(
    version: string,
    asset: string,
    source: OracleSourceName,
    prices: NormalizedPrice[],
    decimals: number,
  ): DriftBaseline {
    const baseline = buildBaseline(version, asset, source, prices, decimals);
    driftBaselineStore.setBaseline(baseline);
    const key = asset;
    const list = this.baselinesByAsset.get(key) ?? [];
    list.push(baseline);
    if (list.length > 10) list.shift();
    this.baselinesByAsset.set(key, list);
    return baseline;
  }

  /**
   * Compare current prices against the latest baseline for each source.
   * Returns drift comparisons for all sources that have baselines.
   */
  detectDrift(asset: string, currentPrices: NormalizedPrice[]): DriftDetectionResult {
    const baselines = driftBaselineStore.getBaselines(asset, 'chainlink')
      .concat(driftBaselineStore.getBaselines(asset, 'redstone'))
      .concat(driftBaselineStore.getBaselines(asset, 'band'))
      .concat(driftBaselineStore.getBaselines(asset, 'reflector'));

    const comparisons: DriftComparison[] = [];
    for (const baseline of baselines) {
      const sourcePrices = currentPrices.filter(
        (p) => p.source === baseline.source,
      );
      // A source with no current samples is data absence, not semantic drift.
      if (sourcePrices.length === 0) continue;
      const comparison = compareAgainstBaseline(
        asset,
        baseline.source,
        sourcePrices,
        baseline,
      );
      comparisons.push(comparison);
    }

    const anyDrift = comparisons.some((c) => c.driftDetected);
    const key = asset;
    this.detectionHistory.set(key, comparisons);
    if (this.detectionHistory.get(key)!.length > 100) {
      this.detectionHistory.get(key)!.shift();
    }

    return { asset, comparisons, anyDrift };
  }

  /**
   * Get the latest drift comparison for an asset/source pair.
   */
  getLatestComparison(
    asset: string,
    source: OracleSourceName,
  ): DriftComparison | undefined {
    const history = this.detectionHistory.get(asset);
    if (!history) return undefined;
    return history
      .filter((c) => c.source === source)
      .pop();
  }

  /**
   * Get all drift comparisons for an asset.
   */
  getHistory(asset: string): DriftComparison[] {
    return this.detectionHistory.get(asset) ?? [];
  }

  /**
   * Check if an asset has active drift on any source.
   */
  hasDrift(asset: string): boolean {
    const result = this.detectDrift(asset, []);
    return result.anyDrift;
  }
}

export const driftDetector = new DriftDetector();
