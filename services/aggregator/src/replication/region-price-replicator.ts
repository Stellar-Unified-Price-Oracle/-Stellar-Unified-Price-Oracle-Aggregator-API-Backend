import { config } from '../infrastructure/config';
import { AggregatedPrice } from '../infrastructure/types';
import { LwwPriceRegister, RegionPriceRecord } from './price-crdt';

export interface DriftReport {
  maxDriftPercent: number;
  maxStalenessMs: number;
  asset?: string;
  regions: string[];
}

export class RegionPriceReplicator {
  private readonly register = new LwwPriceRegister();

  mergeLocalPrices(prices: AggregatedPrice[]): void {
    this.register.mergeLocal(config.region.id, prices);
  }

  mergeRemotePrice(record: Omit<RegionPriceRecord, 'receivedAt' | 'source'>): void {
    this.register.merge({ ...record, receivedAt: Date.now(), source: 'remote' });
  }

  getLatestPrices(): RegionPriceRecord[] {
    return this.register.latestAll();
  }

  getDriftReport(now = Date.now()): DriftReport {
    let maxDriftPercent = 0;
    let maxStalenessMs = 0;
    let asset: string | undefined;
    const regions = new Set<string>();

    for (const price of this.register.latestAll()) {
      const records = this.register.byAsset(price.asset);
      for (const record of records) {
        regions.add(record.region);
        maxStalenessMs = Math.max(maxStalenessMs, now - record.receivedAt);
      }
      const values = records.map((record) => Number(record.price));
      const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      for (const value of values) {
        if (median === 0) continue;
        const drift = Math.abs(value - median) / median * 100;
        if (drift > maxDriftPercent) {
          maxDriftPercent = drift;
          asset = price.asset;
        }
      }
    }

    return { maxDriftPercent, maxStalenessMs, asset, regions: Array.from(regions).sort() };
  }
}
