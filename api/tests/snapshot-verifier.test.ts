import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

import {
  verifyPriceSnapshot,
  TRUSTED_KEYS,
  SUPPORTED_SCHEMA_VERSIONS,
} from '../src/price-serving/snapshot-verifier';
import type { SignedPriceSnapshot } from '../src/price-serving/snapshot-verifier';

const TRUSTED_SECRET = TRUSTED_KEYS['oracle-v1-primary'].secret;

function sign(snapshot: Omit<SignedPriceSnapshot, 'signature'>): string {
  const payload = JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    asset: snapshot.asset,
    price: snapshot.price,
    decimals: snapshot.decimals,
    timestamp: snapshot.timestamp,
    sources: snapshot.sources,
  });
  return crypto.createHmac('sha256', TRUSTED_SECRET).update(payload).digest('hex');
}

function validSnapshot(overrides: Partial<SignedPriceSnapshot> = {}): SignedPriceSnapshot {
  const base: Omit<SignedPriceSnapshot, 'signature'> = {
    schemaVersion: 1,
    asset: 'XLM',
    price: '42000000',
    decimals: 7,
    timestamp: 1700000000,
    sources: ['chainlink', 'redstone'],
    keyId: 'oracle-v1-primary',
  };
  const snapshot = { ...base, ...overrides } as Omit<SignedPriceSnapshot, 'signature'>;
  return { ...snapshot, signature: sign(snapshot) };
}

describe('verifyPriceSnapshot (issue #719)', () => {
  it('accepts a well-formed snapshot with a valid signature', () => {
    const snapshot = validSnapshot();
    const result = verifyPriceSnapshot(snapshot);
    expect(result.valid).toBe(true);
    expect(result.price).toEqual({
      asset: 'XLM',
      price: '42000000',
      decimals: 7,
      timestamp: 1700000000,
      sources: ['chainlink', 'redstone'],
    });
    expect(result.rejection).toBeUndefined();
  });

  it('is deterministic: identical snapshots produce identical results', () => {
    const snapshot = validSnapshot();
    expect(verifyPriceSnapshot(snapshot)).toEqual(verifyPriceSnapshot({ ...snapshot }));
    expect(JSON.stringify(verifyPriceSnapshot(snapshot))).toBe(
      JSON.stringify(verifyPriceSnapshot(snapshot)),
    );
  });

  it('rejects an invalid signature', () => {
    const snapshot = validSnapshot();
    snapshot.signature = '00'.repeat(32);
    const result = verifyPriceSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.rejection?.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const snapshot = validSnapshot();
    snapshot.price = '99999999';
    const result = verifyPriceSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.rejection?.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects an unknown key id', () => {
    const snapshot = validSnapshot({ keyId: 'unknown-key-999' });
    snapshot.signature = sign({ ...snapshot, keyId: 'unknown-key-999' });
    const result = verifyPriceSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.rejection?.code).toBe('UNKNOWN_KEY');
  });

  it('rejects an unsupported schema version', () => {
    const snapshot = validSnapshot({ schemaVersion: 99 });
    snapshot.signature = sign({ ...snapshot, schemaVersion: 99 });
    const result = verifyPriceSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.rejection?.code).toBe('UNSUPPORTED_SCHEMA');
    expect(result.rejection?.message).toContain('99');
    expect(result.rejection?.message).toContain('1');
  });

  it('rejects a malformed snapshot (missing required fields)', () => {
    const result = verifyPriceSnapshot(null as unknown as SignedPriceSnapshot);
    expect(result.valid).toBe(false);
    expect(result.rejection?.code).toBe('MALFORMED');
  });

  it('rejects a snapshot with a non-integer schemaVersion', () => {
    const snapshot = validSnapshot({ schemaVersion: 1.5 } as unknown as SignedPriceSnapshot);
    const result = verifyPriceSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.rejection?.code).toBe('MALFORMED');
  });

  it('rejects a snapshot missing the signature', () => {
    const snapshot = validSnapshot();
    delete snapshot.signature;
    const result = verifyPriceSnapshot(snapshot as unknown as SignedPriceSnapshot);
    expect(result.valid).toBe(false);
    expect(result.rejection?.code).toBe('INVALID_SIGNATURE');
  });

  it('lists supported schema versions', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(1);
    expect(SUPPORTED_SCHEMA_VERSIONS.length).toBeGreaterThan(0);
  });
});
