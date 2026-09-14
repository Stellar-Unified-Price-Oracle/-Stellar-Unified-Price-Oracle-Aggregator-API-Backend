import { describe, it, expect } from 'vitest';
import { LwwPriceRegister } from '../src/replication/price-crdt';
import type { RegionPriceRecord } from '../src/replication/price-crdt';
import type { AggregatedPrice } from '../src/infrastructure/types';

function record(overrides: Partial<RegionPriceRecord> = {}): RegionPriceRecord {
  return {
    region: 'us-east-1',
    asset: 'XLM',
    price: 100n,
    decimals: 7,
    timestamp: 1,
    receivedAt: 1,
    source: 'remote',
    ...overrides,
  };
}

describe('LwwPriceRegister', () => {
  it('returns null / an empty list when nothing has been merged', () => {
    const register = new LwwPriceRegister();
    expect(register.latest('XLM')).toBeNull();
    expect(register.latestAll()).toEqual([]);
    expect(register.size()).toBe(0);
  });

  it('keeps the record with the greatest timestamp on merge', () => {
    const register = new LwwPriceRegister();
    register.merge(record({ timestamp: 10, price: 100n }));
    register.merge(record({ timestamp: 5, price: 99n }));
    expect(register.latest('XLM')?.price).toBe(100n);

    register.merge(record({ timestamp: 11, price: 101n }));
    expect(register.latest('XLM')?.price).toBe(101n);
  });

  it('merges local aggregated prices and records their origin', () => {
    const register = new LwwPriceRegister();
    register.mergeLocal(
      'us-east-1',
      [
        { asset: 'XLM', price: '250', decimals: 7, timestamp: 7 } as unknown as AggregatedPrice,
        { asset: 'BTC', price: 50000n, decimals: 7, timestamp: 8 } as unknown as AggregatedPrice,
      ],
      1234,
    );

    const xlm = register.latest('XLM');
    expect(xlm?.price).toBe(250n);
    expect(xlm?.source).toBe('local');
    expect(xlm?.receivedAt).toBe(1234);
    expect(register.latest('BTC')?.price).toBe(50000n);
  });

  it('exposes records by asset and by region', () => {
    const register = new LwwPriceRegister();
    register.merge(record({ region: 'us-east-1', asset: 'XLM' }));
    register.merge(record({ region: 'eu-west-1', asset: 'XLM', timestamp: 2 }));
    register.merge(record({ region: 'us-east-1', asset: 'BTC', timestamp: 3 }));

    expect(register.byAsset('XLM')).toHaveLength(2);
    expect(register.byRegion('us-east-1')).toHaveLength(2);
    expect(register.size()).toBe(3);
  });

  it('returns one latest record per asset and can be cleared', () => {
    const register = new LwwPriceRegister();
    register.merge(record({ asset: 'XLM', timestamp: 1 }));
    register.merge(record({ asset: 'BTC', timestamp: 2 }));
    register.merge(record({ asset: 'XLM', region: 'eu-west-1', timestamp: 3 }));

    const latest = register.latestAll();
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.asset === 'XLM')?.timestamp).toBe(3);

    register.clear();
    expect(register.size()).toBe(0);
    expect(register.latestAll()).toEqual([]);
  });
});
