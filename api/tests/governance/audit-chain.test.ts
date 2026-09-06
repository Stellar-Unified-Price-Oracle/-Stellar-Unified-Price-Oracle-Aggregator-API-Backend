import { describe, expect, it } from 'vitest';
import { computeAuditHmac, type AuditEntry, verifyAuditLogChain } from '../../src/governance/audit-logger';

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
        hmac: computeAuditHmac({
          ...secondPayload,
          ip: '10.0.0.5',
          prevHmac: first.hmac,
        }, first.hmac),
      },
    ];

    const invalid = verifyAuditLogChain(tampered);
    expect(invalid.valid).toBe(false);
    expect(invalid.firstInvalidIndex).toBe(1);
  });
});
