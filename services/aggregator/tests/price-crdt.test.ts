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

  describe('ownership and epoch rules', () => {
    it('accepts records from the authorized owner region', () => {
      const register = new LwwPriceRegister();
      register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 1 });

      const accepted = register.mergeOwned(
        record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, epoch: 1 }),
      );

      expect(accepted).toBe(true);
      expect(register.latest('XLM')?.price).toBe(100n);
      expect(register.latest('XLM')?.epoch).toBe(1);
    });

    it('rejects records from a non-owner region', () => {
      const register = new LwwPriceRegister();
      register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 1 });
      register.mergeOwned(record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, epoch: 1 }));

      const accepted = register.mergeOwned(
        record({ region: 'eu-west-1', asset: 'XLM', timestamp: 20, price: 999n, epoch: 1 }),
      );

      expect(accepted).toBe(false);
      expect(register.latest('XLM')?.price).toBe(100n);
      expect(register.latest('XLM')?.region).toBe('us-east-1');
    });

    it('rejects stale-epoch records even from the current owner', () => {
      const register = new LwwPriceRegister();
      register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 2 });
      register.mergeOwned(record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, epoch: 2 }));

      const accepted = register.mergeOwned(
        record({ region: 'us-east-1', asset: 'XLM', timestamp: 99, price: 1n, epoch: 1 }),
      );

      expect(accepted).toBe(false);
      expect(register.latest('XLM')?.price).toBe(100n);
      expect(register.latest('XLM')?.epoch).toBe(2);
    });

    it('rejects records for an asset with no ownership assignment', () => {
      const register = new LwwPriceRegister();
      const accepted = register.mergeOwned(
        record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, epoch: 1 }),
      );
      expect(accepted).toBe(false);
      expect(register.latest('XLM')).toBeNull();
    });

    it('treats equal epochs from the owner as valid and resolves by timestamp', () => {
      const register = new LwwPriceRegister();
      register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 1 });
      register.mergeOwned(record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, price: 100n, epoch: 1 }));

      const accepted = register.mergeOwned(
        record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, price: 200n, epoch: 1 }),
      );

      expect(accepted).toBe(true);
      // Equal timestamps: deterministic tie-break keeps a single stable value.
      expect(register.latest('XLM')?.price).toBe(200n);
      expect(register.latest('XLM')?.epoch).toBe(1);
    });

    it('rejects an ownership change that conflicts with an existing owner at the same epoch', () => {
      const register = new LwwPriceRegister();
      register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 1 });

      const applied = register.setOwnership({ asset: 'XLM', ownerRegion: 'eu-west-1', epoch: 1 });

      expect(applied).toBe(false);
      expect(register.ownership('XLM')?.ownerRegion).toBe('us-east-1');
    });

    it('transfers ownership on a higher epoch and rejects the old owner afterwards', () => {
      const register = new LwwPriceRegister();
      register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 1 });
      register.mergeOwned(record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, epoch: 1 }));

      const applied = register.setOwnership({ asset: 'XLM', ownerRegion: 'eu-west-1', epoch: 2 });
      expect(applied).toBe(true);

      expect(
        register.mergeOwned(record({ region: 'us-east-1', asset: 'XLM', timestamp: 20, epoch: 2 })),
      ).toBe(false);
      expect(
        register.mergeOwned(record({ region: 'eu-west-1', asset: 'XLM', timestamp: 20, price: 300n, epoch: 2 })),
      ).toBe(true);
      expect(register.latest('XLM')?.price).toBe(300n);
      expect(register.latest('XLM')?.region).toBe('eu-west-1');
    });

    it('converges after a failback epoch bump regardless of merge order', () => {
      const build = (order: 'forward' | 'reverse') => {
        const register = new LwwPriceRegister();
        register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 1 });
        register.mergeOwned(record({ region: 'us-east-1', asset: 'XLM', timestamp: 10, price: 100n, epoch: 1 }));

        // Failover to eu-west-1 at epoch 2, then failback to us-east-1 at epoch 3.
        register.setOwnership({ asset: 'XLM', ownerRegion: 'eu-west-1', epoch: 2 });
        register.mergeOwned(record({ region: 'eu-west-1', asset: 'XLM', timestamp: 20, price: 200n, epoch: 2 }));
        register.setOwnership({ asset: 'XLM', ownerRegion: 'us-east-1', epoch: 3 });

        const records = [
          record({ region: 'us-east-1', asset: 'XLM', timestamp: 30, price: 300n, epoch: 3 }),
          record({ region: 'eu-west-1', asset: 'XLM', timestamp: 25, price: 250n, epoch: 2 }),
        ];
        for (const r of order === 'forward' ? records : [...records].reverse()) {
          register.mergeOwned(r);
        }
        return register;
      };

      const forward = build('forward');
      const reverse = build('reverse');

      expect(forward.latest('XLM')?.price).toBe(300n);
      expect(reverse.latest('XLM')?.price).toBe(300n);
      expect(forward.latest('XLM')?.epoch).toBe(3);
      expect(reverse.latest('XLM')?.epoch).toBe(3);
      expect(forward.latest('XLM')?.region).toBe('us-east-1');
      expect(reverse.latest('XLM')?.region).toBe('us-east-1');
    });
  });
});
