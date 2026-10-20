import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProviderEvidenceArchive } from '../src/persistence/provider-evidence-archive';
import { OracleSourceName } from '../src/infrastructure/types';

vi.mock('../src/observability/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'provider-evidence-test-'));
}

describe('Issue #686 — Provider evidence archive', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('is a no-op when disabled', () => {
    const archive = new ProviderEvidenceArchive({
      enabled: false,
      dir,
      maxEntries: 100,
      retentionDays: 30,
      redactKeys: ['apikey'],
    });
    expect(archive.isEnabled()).toBe(false);
    expect(archive.record({ source: 'chainlink', asset: 'XLM', responseBody: { a: 1 } })).toBeNull();
    expect(readdirSync(dir).length).toBe(0);
  });

  it('writes a redacted evidence record with timestamp and correlation id', () => {
    const archive = new ProviderEvidenceArchive({
      enabled: true,
      dir,
      maxEntries: 100,
      retentionDays: 30,
      redactKeys: ['api_key', 'authorization'],
    });
    const path = archive.record({
      correlationId: 'corr-123',
      source: 'chainlink',
      asset: 'XLM',
      providerObservedAt: 1700000000,
      requestUrl: 'https://example.com/price?api_key=secret',
      requestMethod: 'GET',
      responseStatus: 200,
      responseBody: { USD: { PRICE: '1' }, api_key: 'secret' },
    });
    expect(path).toBeTruthy();
    const files = readdirSync(dir);
    expect(files.length).toBe(1);

    const content = JSON.parse(readFileText(join(dir, files[0])));
    expect(content.correlationId).toBe('corr-123');
    expect(content.source).toBe('chainlink');
    expect(content.asset).toBe('XLM');
    expect(content.archivedAt).toBeGreaterThan(0);
    expect(content.providerObservedAt).toBe(1700000000);
    expect(content.responseStatus).toBe(200);
    // Redaction of request/response sensitive fields (paths are relative to the
    // redacted responseBody object).
    expect(content.responseBody.api_key).toBe('***REDACTED***');
    expect(content.redactedFields).toContain('$.api_key');
    expect(content.requestUrl).not.toContain('secret');
    expect(content.ttlExpiresAt).toBeGreaterThan(content.archivedAt);
  });

  it('generates a correlation id when none is supplied', () => {
    const archive = new ProviderEvidenceArchive({
      enabled: true,
      dir,
      maxEntries: 100,
      retentionDays: 30,
      redactKeys: ['apikey'],
    });
    const path = archive.record({
      source: 'redstone',
      asset: 'USDC',
      responseBody: { XLM: { value: '1', decimals: 8 } },
    });
    expect(path).toBeTruthy();
    const content = JSON.parse(readFileText(path!));
    expect(typeof content.correlationId).toBe('string');
    expect(content.correlationId.length).toBeGreaterThan(0);
  });

  it('prunes expired records by ttl', () => {
    const archive = new ProviderEvidenceArchive({
      enabled: true,
      dir,
      maxEntries: 100,
      retentionDays: 30,
      redactKeys: ['api_key'],
    });
    const past = Math.floor(Date.now() / 1000) - 100;
    // Write records directly whose TTL is already in the past (record() would
    // compute a future TTL, so we bypass it to exercise the expiry path).
    const expiredRecord = (correlationId: string) =>
      JSON.stringify({
        correlationId,
        source: 'band',
        asset: 'XLM',
        archivedAt: past,
        providerObservedAt: null,
        requestUrl: 'https://example.com/price',
        requestMethod: 'GET',
        responseStatus: 200,
        responseBody: { data: { price: '1' } },
        redactedFields: [],
        ttlExpiresAt: past - 1,
      });
    writeFileSync(join(dir, 'expired-1.json'), expiredRecord('expired-1'));
    writeFileSync(join(dir, 'expired-2.json'), expiredRecord('expired-2'));
    expect(readdirSync(dir).length).toBe(2);
    archive.prune();
    expect(readdirSync(dir).length).toBe(0);
  });

  it('prunes oldest records when over maxEntries', () => {
    const archive = new ProviderEvidenceArchive({
      enabled: true,
      dir,
      maxEntries: 2,
      retentionDays: 30,
      redactKeys: ['api_key'],
    });
    const now = Math.floor(Date.now() / 1000);
    archive.record({
      correlationId: 'a',
      source: 'chainlink',
      asset: 'XLM',
      archivedAt: now - 200,
      responseBody: { a: 1 },
    });
    archive.record({
      correlationId: 'b',
      source: 'chainlink',
      asset: 'XLM',
      archivedAt: now - 100,
      responseBody: { b: 1 },
    });
    archive.record({
      correlationId: 'c',
      source: 'chainlink',
      asset: 'XLM',
      archivedAt: now,
      responseBody: { c: 1 },
    });
    expect(readdirSync(dir).length).toBeLessThanOrEqual(2);
    const remaining = readdirSync(dir).map((f) => JSON.parse(readFileText(join(dir, f))));
    expect(remaining.some((r) => r.correlationId === 'a')).toBe(false); // oldest pruned
    expect(remaining.some((r) => r.correlationId === 'c')).toBe(true);
  });
});

function readFileText(path: string): string {
  return readFileSync(path, 'utf-8');
}
