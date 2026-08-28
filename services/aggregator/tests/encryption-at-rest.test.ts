import { describe, it, expect } from 'vitest';
import { decrypt, encrypt, isEncrypted } from '../src/infrastructure/crypto';
import { LwwPriceRegister } from '../src/replication/price-crdt';
import { RegionQuarantineManager } from '../src/replication/region-quarantine';
import { config } from '../src/infrastructure/config';

describe('historical data encryption at rest', () => {
  it('decrypts data written before key rotation when previous key is configured', () => {
    const previous = 'previous-key';
    const active = 'active-key';
    const encrypted = encrypt('[{"asset":"XLM","price":"100"}]', { active: previous });

    expect(isEncrypted(encrypted)).toBe(true);
    expect(decrypt(encrypted, { active, previous })).toBe('[{"asset":"XLM","price":"100"}]');
  });
});

describe('multi-region CRDT and quarantine', () => {
  it('uses last-writer-wins price convergence per asset', () => {
    const register = new LwwPriceRegister();

    register.merge({ region: 'us-east-1', asset: 'XLM', price: '100', decimals: 7, timestamp: 10, receivedAt: 10, source: 'remote' });
    register.merge({ region: 'eu-west-1', asset: 'XLM', price: '101', decimals: 7, timestamp: 11, receivedAt: 11, source: 'remote' });

    expect(register.latest('XLM')?.region).toBe('eu-west-1');
    expect(register.latest('XLM')?.price).toBe('101');
  });

  it('quarantines a region when drift exceeds the configured threshold', () => {
    config.region.quarantineEnabled = true;
    config.region.driftAlertPercent = 0.1;

    const quarantine = new RegionQuarantineManager();
    const status = quarantine.evaluate({
      maxDriftPercent: 0.2,
      maxStalenessMs: 100,
      asset: 'XLM',
      regions: ['us-east-1', 'eu-west-1'],
    });

    expect(status.quarantined).toBe(true);
  });
});
