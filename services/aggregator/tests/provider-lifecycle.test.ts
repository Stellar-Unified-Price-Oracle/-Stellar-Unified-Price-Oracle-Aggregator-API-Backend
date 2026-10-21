import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertSandboxIsolation, providerApiKey, readSandboxLease, rotateSandboxLease, sandboxTokenMatches } from '../src/oracle-sources/sandbox-credentials';
import { classifyProviderError } from '../src/oracle-sources/provider-errors';
import { reviewProviderCutover, type CutoverEvidence } from '../src/oracle-sources/cutover-readiness';

const directories: string[] = [];
function leasePath() {
  const dir = mkdtempSync(join(tmpdir(), 'provider-lease-'));
  directories.push(dir);
  return join(dir, 'lease.json');
}
afterEach(() => directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

describe('sandbox credential lifecycle', () => {
  it('issues private leases, rotates without overlap, and rejects at expiry', () => {
    const file = leasePath();
    const a = rotateSandboxLease(file, 'http://127.0.0.1:4010', 1000, 1000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSandboxLease(file, a.origin, 1999)).toEqual(a);
    expect(() => readSandboxLease(file, a.origin, 2000)).toThrow();
    expect(() => readSandboxLease(file, a.origin, 999)).toThrow();
    const b = rotateSandboxLease(file, a.origin, 1000, 1500);
    expect(b.token).not.toBe(a.token);
    expect(sandboxTokenMatches(a.token, readSandboxLease(file, a.origin, 1500).token)).toBe(false);
    expect(sandboxTokenMatches(b.token, b.token)).toBe(true);
    expect(sandboxTokenMatches('é', 'ab')).toBe(false);
  });
  it.each([0, 999, 86400001, NaN, Infinity])('rejects invalid TTL %s', ttl => {
    expect(() => rotateSandboxLease(leasePath(), 'http://127.0.0.1:4010', ttl)).toThrow();
  });
  it('rejects production, malformed and wrong-origin leases', () => {
    const file = leasePath();
    const a = rotateSandboxLease(file, 'http://127.0.0.1:4010');
    expect(() => readSandboxLease(file, 'http://127.0.0.1:4011')).toThrow();
    writeFileSync(file, JSON.stringify({ ...a, environment: 'production' }));
    expect(() => readSandboxLease(file, a.origin)).toThrow();
    writeFileSync(file, '{');
    expect(() => readSandboxLease(file, a.origin)).toThrow();
    expect(() => rotateSandboxLease(file, 'https://api.production.example')).toThrow();
  });
  it.each(['test', 'development'])('rejects global and regional production secrets in %s', NODE_ENV => {
    for (const key of ['CHAINLINK_API_KEY', 'CHAINLINK_API_KEY_US_EAST', 'BAND_API_KEY']) {
      expect(() => assertSandboxIsolation({ NODE_ENV, [key]: 'production-secret' })).toThrow();
    }
    expect(() => assertSandboxIsolation({ NODE_ENV, REDSTONE_BASE_URL_US_EAST: 'https://prod.example' })).toThrow();
    expect(() => assertSandboxIsolation({ NODE_ENV, CHAINLINK_BASE_URL: 'http://127.0.0.1:4010' })).not.toThrow();
  });
  it('reads a rotated token per request and preserves production credentials only in production', () => {
    const file = leasePath();
    const origin = 'http://127.0.0.1:4010';
    const env = { PROVIDER_ENVIRONMENT: 'sandbox', SANDBOX_PROVIDER_LEASE_FILE: file };
    const a = rotateSandboxLease(file, origin);
    expect(providerApiKey(origin, '', env)).toBe(a.token);
    const b = rotateSandboxLease(file, origin);
    expect(providerApiKey(origin, '', env)).toBe(b.token);
    expect(() => providerApiKey(origin, 'prod-key', env)).toThrow();
    expect(() => providerApiKey('https://prod.example', '', env)).toThrow();
    expect(providerApiKey('https://prod.example', 'prod-key', { NODE_ENV: 'production' })).toBe('prod-key');
  });
});

describe('stable provider error categories', () => {
  it.each([
    [{ response: { status: 401 } }, 'authentication', false],
    [{ response: { status: 403 } }, 'authentication', false],
    [{ response: { status: 429 } }, 'rate-limited', true],
    [{ response: { status: 404 } }, 'no-price', false],
    [{ response: { status: 500 } }, 'unavailable', true],
    [{ response: { status: 504 } }, 'timeout', true],
    [{ code: 'ETIMEDOUT' }, 'timeout', true],
    [{ code: 'ECONNABORTED' }, 'timeout', true],
    [{ code: 'ECONNRESET' }, 'unavailable', true],
    [{ name: 'SsrfError' }, 'policy-blocked', false],
    [{ name: 'SandboxCredentialError' }, 'policy-blocked', false],
    [null, 'unknown', false],
    [new Error('secret-token'), 'unknown', false],
  ])('classifies %o without diagnostic leakage', (error, category, retryable) => {
    expect(classifyProviderError(error)).toEqual({ category, retryable });
    expect(JSON.stringify(classifyProviderError(error))).not.toContain('secret-token');
  });
});

const now = 1700000000000;
function evidence(): CutoverEvidence {
  return {
    version: 1, provider: 'band', fromVersion: 'repository-v1', toVersion: 'provider-v2',
    owner: 'provider-maintainer', reviewer: 'on-call', reviewedAt: now, decision: 'go',
    fixtureReport: 'artifact:fixtures', upstreamContractEvidence: 'artifact:announcement',
    sandboxIsolationReport: 'artifact:isolation', monitoringDashboard: 'artifact:dashboard',
    rollback: { owner: 'on-call', steps: 'restore pinned endpoint and image', rehearsalReport: 'artifact:rollback', recoverySeconds: 300 },
    feeds: [{ asset: 'XLM', shadowReport: 'artifact:shadow', shadowDurationHours: 24, pairedSamples: 1000, errors: 1, staleSamples: 0, maxDeviationBps: 50, p99LatencyMs: 5000, requiredQuorum: 2, healthyIndependentSourcesAfter: 3, healthyIndependentSourcesWithoutCandidate: 2 }],
  };
}
describe('provider cutover evidence gate', () => {
  it('allows complete evidence exactly at documented boundaries', () => {
    expect(reviewProviderCutover(evidence(), now)).toEqual({ allowed: true, reasons: [] });
    expect(reviewProviderCutover(evidence(), now + 86400000).allowed).toBe(true);
  });
  it.each([
    (e: CutoverEvidence) => { e.decision = 'no-go'; },
    (e: CutoverEvidence) => { e.reviewer = e.owner; },
    (e: CutoverEvidence) => { e.reviewedAt = now + 1; },
    (e: CutoverEvidence) => { e.reviewedAt = now - 86400001; },
    (e: CutoverEvidence) => { e.rollback.recoverySeconds = 301; },
    (e: CutoverEvidence) => { e.feeds[0].pairedSamples = 999; },
    (e: CutoverEvidence) => { e.feeds[0].shadowDurationHours = 23; },
    (e: CutoverEvidence) => { e.feeds[0].errors = 2; },
    (e: CutoverEvidence) => { e.feeds[0].staleSamples = 1; },
    (e: CutoverEvidence) => { e.feeds[0].maxDeviationBps = 51; },
    (e: CutoverEvidence) => { e.feeds[0].p99LatencyMs = 5001; },
    (e: CutoverEvidence) => { e.feeds[0].healthyIndependentSourcesWithoutCandidate = 1; },
    (e: CutoverEvidence) => { e.feeds[0].healthyIndependentSourcesAfter = 1; },
    (e: CutoverEvidence) => { e.fixtureReport = ''; },
    (e: CutoverEvidence) => { e.feeds.push({ ...e.feeds[0] }); },
  ])('blocks incomplete or failing evidence %#', mutate => {
    const e = evidence(); mutate(e);
    expect(reviewProviderCutover(e, now).allowed).toBe(false);
  });
  it.each([null, {}, { version: 2 }, { ...evidence(), feeds: [] }])('fails closed on malformed input %o', e => {
    expect(reviewProviderCutover(e, now).allowed).toBe(false);
  });
});
