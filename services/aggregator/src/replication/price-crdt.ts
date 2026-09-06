import { AggregatedPrice } from '../infrastructure/types';

export interface RegionPriceRecord {
  region: string;
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  receivedAt: number;
  source: 'local' | 'remote';
  /** W3C trace context carried across the replication bus (issue #419). */
  traceparent?: string;
  tracestate?: string;
}

export class LwwPriceRegister {
  private values = new Map<string, RegionPriceRecord>();

  /**
   * Merge a price record using last-writer-wins semantics.
   * The record with the greatest timestamp wins.
   */
  merge(record: RegionPriceRecord): void {
    const key = `${record.region}:${record.asset}`;
    const current = this.values.get(key);
    
    // LWW: only update if new record has later timestamp
    if (!current || record.timestamp > current.timestamp) {
      this.values.set(key, record);
    }
  }

  /**
   * Merge local prices into the register
   */
  mergeLocal(region: string, prices: AggregatedPrice[], now = Date.now()): void {
    for (const price of prices) {
      this.merge({
        region,
        asset: price.asset,
        price: typeof price.price === 'bigint' ? price.price : BigInt(price.price),
        decimals: price.decimals,
        timestamp: price.timestamp,
        receivedAt: now,
        source: 'local',
      });
    }
  }

  /**
   * Get the latest (highest timestamp) record for a specific asset across all regions
   */
  latest(asset: string): RegionPriceRecord | null {
    const candidates = Array.from(this.values.values()).filter((record) => record.asset === asset);
    if (candidates.length === 0) return null;
    return candidates.reduce((winner, record) => (
      record.timestamp > winner.timestamp ? record : winner
    ));
  }

  /**
   * Get the latest record for each unique asset
   */
  latestAll(): RegionPriceRecord[] {
    const assets = new Set(Array.from(this.values.values()).map((record) => record.asset));
    return Array.from(assets)
      .map((asset) => this.latest(asset))
      .filter((record): record is RegionPriceRecord => record !== null);
  }

  /**
   * Get all records for a specific asset from all regions
   */
  byAsset(asset: string): RegionPriceRecord[] {
    return Array.from(this.values.values()).filter((record) => record.asset === asset);
  }

  /**
   * Get all records for a specific region
   */
  byRegion(region: string): RegionPriceRecord[] {
    return Array.from(this.values.values()).filter((record) => record.region === region);
  }

  /**
   * Get the number of stored records
   */
  size(): number {
    return this.values.size;
  }

  /**
   * Clear all stored records
   */
  clear(): void {
    this.values.clear();
  }
}
