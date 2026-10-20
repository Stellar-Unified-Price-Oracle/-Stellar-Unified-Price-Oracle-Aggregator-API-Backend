import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  computeAuditHmac,
  currentAuditKeyId,
  getAuditLogFile,
  initializeAuditIntegrity,
  loadAuditSecrets,
  type AuditEntry,
  verifyAuditLogChain,
} from '../../src/governance/audit-logger';

const currentKeyId = currentAuditKeyId();

function makeEntry(overrides: Partial<AuditEntry> & Pick<AuditEntry, 'event' | 'writerId' | 'seq'>): AuditEntry {
  const base = {
    timestamp: '2024-02-01T12:00:00.000Z',
    ip: '127.0.0.1',
    userAgent: 'vitest',
    apiKeyPrefix: 'abc123',
    keyId: currentKeyId,
    ...overrides,
  };
  const { hmac: _hmac, ...fields } = base as AuditEntry;
  return { ...fields, hmac: computeAuditHmac(fields, base.prevHmac ?? '') } as AuditEntry;
}

describe('audit log chain', () => {
  it('detects tampering in the hash chain', () => {
    const firstPayload = {
      event: 'auth.success' as const,
      timestamp: '2024-02-01T12:00:00.000Z',
      ip: '127.0.0.1',
      userAgent: 'vitest',
      apiKeyPrefix: 'abc123',
    };
    const first: AuditEntry = {
      ...firstPayload,
      hmac: computeAuditHmac(firstPayload, ''),
    };

    const secondPayload = {
      event: 'governance.vote_cast' as const,
      timestamp: '2024-02-01T12:01:00.000Z',
      ip: '127.0.0.1',
      userAgent: 'vitest',
      apiKeyPrefix: 'abc123',
      details: { proposalId: 7 },
    };
    const second: AuditEntry = {
      ...secondPayload,
      prevHmac: first.hmac,
      hmac: computeAuditHmac({
        ...secondPayload,
        prevHmac: first.hmac,
      }, first.hmac),
    };

    const valid = verifyAuditLogChain([first, second]);
    expect(valid.valid).toBe(true);

    const tampered = [
      first,
      {
        ...second,
        ip: '10.0.0.5',
      },
    ];

    const invalid = verifyAuditLogChain(tampered);
    expect(invalid.valid).toBe(false);
    expect(invalid.firstInvalidIndex).toBe(1);
  });

  it('verifies two writers interleaved in one log', () => {
    const writerA1 = makeEntry({ event: 'auth.success', writerId: 'replica-a', seq: 1, prevHmac: '' });
    const writerB1 = makeEntry({
      event: 'auth.failure',
      writerId: 'replica-b',
      seq: 1,
      prevHmac: writerA1.hmac,
    });
    const writerA2 = makeEntry({
      event: 'admin.key_rotated',
      writerId: 'replica-a',
      seq: 2,
      prevHmac: writerA1.hmac,
      details: { keyPrefix: 'sk_pr' },
    });
    const writerB2 = makeEntry({
      event: 'governance.vote_cast',
      writerId: 'replica-b',
      seq: 2,
      prevHmac: writerB1.hmac,
    });

    const interleaved = [writerA1, writerB1, writerA2, writerB2];
    expect(verifyAuditLogChain(interleaved)).toEqual({ valid: true, firstInvalidIndex: null });
  });

  it('detects a removed entry inside one writer chain', () => {
    const first = makeEntry({ event: 'auth.success', writerId: 'replica-a', seq: 1, prevHmac: '' });
    const second = makeEntry({
      event: 'auth.failure',
      writerId: 'replica-a',
      seq: 2,
      prevHmac: first.hmac,
    });
    const third = makeEntry({
      event: 'admin.key_rotated',
      writerId: 'replica-a',
      seq: 3,
      prevHmac: second.hmac,
    });

    const result = verifyAuditLogChain([first, third]);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(1);
  });

  it('detects a writer chain anchored to an entry that no longer exists', () => {
    const foreign = makeEntry({ event: 'auth.success', writerId: 'replica-a', seq: 1, prevHmac: '' });
    const orphan = makeEntry({
      event: 'auth.failure',
      writerId: 'replica-b',
      seq: 1,
      prevHmac: '0'.repeat(64),
    });

    const result = verifyAuditLogChain([foreign, orphan]);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(1);
  });

  it('requires an explicit secret in production', () => {
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.AUDIT_SECRET;
    const previousPreviousSecret = process.env.AUDIT_SECRET_PREVIOUS;

    process.env.NODE_ENV = 'production';
    delete process.env.AUDIT_SECRET;
    delete process.env.AUDIT_SECRET_PREVIOUS;

    try {
      expect(() => loadAuditSecrets()).toThrow(/AUDIT_SECRET is required/);
      expect(() => initializeAuditIntegrity()).toThrow(/AUDIT_SECRET is required/);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousSecret !== undefined) process.env.AUDIT_SECRET = previousSecret;
      if (previousPreviousSecret !== undefined) process.env.AUDIT_SECRET_PREVIOUS = previousPreviousSecret;
    }
  });

  it('records key inventory lifecycle events (rotation, retirement, algorithm transition) in the chain', () => {
    const keyRegistered = makeEntry({
      event: 'admin.key_registered',
      writerId: 'replica-a',
      seq: 1,
      prevHmac: '',
      details: {
        keyId: 'audit-hmac-v1',
        purpose: 'audit-hmac',
        algorithm: 'sha256',
        owner: 'security-team',
      },
    });
    const keyRotated = makeEntry({
      event: 'admin.key_rotated',
      writerId: 'replica-a',
      seq: 2,
      prevHmac: keyRegistered.hmac,
      details: {
        keyId: 'audit-hmac-v2',
        previousKeyId: 'audit-hmac-v1',
        purpose: 'audit-hmac',
        algorithm: 'sha256',
        owner: 'security-team',
      },
    });
    const algorithmTransition = makeEntry({
      event: 'admin.key_algorithm_transitioned',
      writerId: 'replica-a',
      seq: 3,
      prevHmac: keyRotated.hmac,
      details: {
        keyId: 'audit-hmac-v3',
        previousKeyId: 'audit-hmac-v2',
        fromAlgorithm: 'sha256',
        toAlgorithm: 'sha512',
        owner: 'security-team',
      },
    });
    const keyRetired = makeEntry({
      event: 'admin.key_retired',
      writerId: 'replica-a',
      seq: 4,
      prevHmac: algorithmTransition.hmac,
      details: {
        keyId: 'audit-hmac-v1',
        reason: 'superseded',
        owner: 'security-team',
      },
    });

    const lifecycle = [keyRegistered, keyRotated, algorithmTransition, keyRetired];
    expect(verifyAuditLogChain(lifecycle)).toEqual({ valid: true, firstInvalidIndex: null });

    const tamperedTransition = lifecycle.map((entry, index) =>
      index === 2
        ? { ...entry, details: { ...entry.details, toAlgorithm: 'md5' } }
        : entry,
    );
    const invalid = verifyAuditLogChain(tamperedTransition);
    expect(invalid.valid).toBe(false);
    expect(invalid.firstInvalidIndex).toBe(2);
  });

  it('detects a dropped key retirement event in the lifecycle chain', () => {
    const registered = makeEntry({
      event: 'admin.key_registered',
      writerId: 'replica-a',
      seq: 1,
      prevHmac: '',
      details: { keyId: 'audit-hmac-v1', owner: 'security-team' },
    });
    const rotated = makeEntry({
      event: 'admin.key_rotated',
      writerId: 'replica-a',
      seq: 2,
      prevHmac: registered.hmac,
      details: { keyId: 'audit-hmac-v2', previousKeyId: 'audit-hmac-v1', owner: 'security-team' },
    });
    const retired = makeEntry({
      event: 'admin.key_retired',
      writerId: 'replica-a',
      seq: 3,
      prevHmac: rotated.hmac,
      details: { keyId: 'audit-hmac-v1', reason: 'superseded', owner: 'security-team' },
    });

    const result = verifyAuditLogChain([registered, retired]);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(1);
  });

  it('refuses to append to an unverifiable chain when AUDIT_CHAIN_ON_BREAK=throw', () => {
    const file = getAuditLogFile();
    const existed = fs.existsSync(file);
    const backup = existed ? fs.readFileSync(file, 'utf8') : '';
    const broken = makeEntry({ event: 'auth.success', writerId: 'replica-a', seq: 1, prevHmac: '' });
    const tampered: AuditEntry = { ...broken, ip: '10.0.0.9' };

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`, 'utf8');
    process.env.AUDIT_CHAIN_ON_BREAK = 'throw';

    try {
      expect(() => initializeAuditIntegrity()).toThrow(/unverifiable audit log/);
    } finally {
      delete process.env.AUDIT_CHAIN_ON_BREAK;
      if (existed) fs.writeFileSync(file, backup, 'utf8');
      else if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });
});
