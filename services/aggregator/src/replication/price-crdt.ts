import { AggregatedPrice } from '../infrastructure/types';

export interface RegionPriceRecord {
  region: string;
  asset: string;
  price: string;
  decimals: number;
  timestamp: number;
  receivedAt: number;
  source: 'local' | 'remote';
}

export class LwwPriceRegister {
  private values = new Map<string, RegionPriceRecord>();

  merge(record: RegionPriceRecord): void {
    const key = `${record.region}:${record.asset}`;
    const current = this.values.get(key);
    if (!current || record.timestamp > current.timestamp) {
      this.values.set(key, record);
    }
  }

  mergeLocal(region: string, prices: AggregatedPrice[], now = Date.now()): void {
    for (const price of prices) {
      this.merge({
        region,
        asset: price.asset,
        price: price.price,
        decimals: price.decimals,
        timestamp: price.timestamp,
        receivedAt: now,
        source: 'local',
      });
    }
  }

  latest(asset: string): RegionPriceRecord | null {
    const candidates = Array.from(this.values.values()).filter((record) => record.asset === asset);
    if (candidates.length === 0) return null;
    return candidates.reduce((winner, record) => (
      record.timestamp > winner.timestamp ? record : winner
    ));
  }

  latestAll(): RegionPriceRecord[] {
    const assets = new Set(Array.from(this.values.values()).map((record) => record.asset));
    return Array.from(assets)
      .map((asset) => this.latest(asset))
      .filter((record): record is RegionPriceRecord => record !== null);
  }

  byAsset(asset: string): RegionPriceRecord[] {
    return Array.from(this.values.values()).filter((record) => record.asset === asset);
  }
}
