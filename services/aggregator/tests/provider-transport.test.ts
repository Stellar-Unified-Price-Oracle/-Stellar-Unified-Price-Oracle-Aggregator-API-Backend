import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseProviderResponse, type ProviderSchemaName } from '../src/oracle-sources/response-validation';

vi.mock('../src/price-aggregation/source-circuit-breaker', () => ({ sourceCircuitBreaker: { isAllowed: vi.fn(() => true), recordSuccess: vi.fn(), recordFailure: vi.fn() } }));
vi.mock('../src/domain-events', () => ({ eventBus: { publish: vi.fn() } }));
vi.mock('../src/observability/alert-manager', () => ({ default: class { checkInvalidPayload = vi.fn(); } }));
vi.mock('../src/infrastructure/http-client', () => ({ httpClient: { get: vi.fn() } }));
vi.mock('../src/infrastructure/config', () => ({ config: { sources: Object.fromEntries(['chainlink', 'redstone', 'band', 'reflector'].map(p => [p, { baseUrl: 'http://127.0.0.1:4010', apiKey: '' }])) } }));
vi.mock('../src/persistence/provider-evidence-archive', () => ({ providerEvidenceArchive: { record: vi.fn() } }));
import { httpClient } from '../src/infrastructure/http-client';
import { ChainlinkSource } from '../src/oracle-sources/chainlink';
import { RedstoneSource } from '../src/oracle-sources/redstone';
import { BandSource } from '../src/oracle-sources/band';
import { ReflectorSource } from '../src/oracle-sources/reflector';

const adapters = { chainlink: ChainlinkSource, redstone: RedstoneSource, band: BandSource, reflector: ReflectorSource };
interface TransportRecord {
  provider: ProviderSchemaName;
  contractVersion: string;
  status: 'current' | 'announced';
  provenance: { kind: string; source: string; recordedAt: string; upstreamAnnouncement: string | null };
  request: { method: string; path: string; params: Record<string, string> };
  response: { status: number; body: unknown };
  expected: { asset: string; price: string; decimals: number; observedAt: number | null };
}
const directory = join(__dirname, 'fixtures/provider-transport');
const records: TransportRecord[] = readdirSync(directory).filter(f => f.endsWith('.json')).flatMap(file => {
  const envelope = JSON.parse(readFileSync(join(directory, file), 'utf8'));
  if (envelope.fixtureVersion !== 1) throw new Error(`Unsupported fixture envelope: ${file}`);
  return envelope.records;
});
beforeEach(() => vi.clearAllMocks());
describe('versioned provider transport replay', () => {
  it('covers every supported adapter with a current contract and unique versions', () => {
    expect(new Set(records.filter(r => r.status === 'current').map(r => r.provider))).toEqual(new Set(Object.keys(adapters)));
    expect(new Set(records.map(r => `${r.provider}:${r.contractVersion}`)).size).toBe(records.length);
  });
  for (const r of records) {
    describe(`${r.provider}/${r.contractVersion}/${r.status}`, () => {
      it('records provenance and requires a real announcement for announced versions', () => {
        expect(r.provenance.source).toBeTruthy();
        expect(Number.isFinite(Date.parse(r.provenance.recordedAt))).toBe(true);
        if (r.status === 'announced') expect(r.provenance.upstreamAnnouncement).toMatch(/^https:\/\//);
        expect(JSON.stringify(r)).not.toMatch(/(?:ghp_|ghu_|sbx_)[a-zA-Z0-9]{20}/);
      });
      it('replays the request and response through the adapter with exact scale and observation time', async () => {
        vi.mocked(httpClient.get).mockResolvedValue({ status: r.response.status, data: r.response.body } as never);
        const price = await new adapters[r.provider]().fetchPrice(r.expected.asset);
        expect(price).toMatchObject({ asset: r.expected.asset, price: BigInt(r.expected.price), decimals: r.expected.decimals, observedAt: r.expected.observedAt, source: r.provider });
        const [url, options] = vi.mocked(httpClient.get).mock.calls[0];
        expect(url).toBe(`http://127.0.0.1:4010${r.request.path}`);
        expect(r.request.method).toBe('GET');
        expect(options?.params ?? {}).toEqual(Object.fromEntries(Object.entries(r.request.params).map(([key, value]) => [key, value === '[REDACTED]' ? '' : value])));
      });
      it('rejects an unrecognized future envelope instead of mispricing', () => {
        expect(parseProviderResponse(r.provider, { nextVersion: { quotes: [{ price: '0.12' }] } }, 'XLM').kind).toBe('invalid-payload');
      });
      it('accepts additive provider metadata', () => {
        const body = { ...(r.response.body as object), ...(r.provider === 'redstone' ? { OTHER: { value: '1' } } : { metadata: { release: 'candidate' } }) };
        expect(parseProviderResponse(r.provider, body, 'XLM').kind).toBe('ok');
      });
    });
  }
  it.each([
    ['redstone', {}], ['band', { data: null }], ['reflector', { prices: {} }],
  ] as const)('distinguishes an unsupported asset for %s', (provider, body) => {
    expect(parseProviderResponse(provider, body, 'UNKNOWN').kind).toBe('no-price');
  });
  it.each([0, -1, 'NaN', 'Infinity', '', null])('rejects unusable price %s', price => {
    for (const [provider, body] of Object.entries({ chainlink: { USD: { PRICE: price } }, redstone: { XLM: { value: price } }, band: { data: { price } }, reflector: { prices: { 'Crypto.XLM/USD': { price } } } })) {
      expect(parseProviderResponse(provider as ProviderSchemaName, body, 'XLM').kind).toBe('invalid-payload');
    }
  });
});

import { sourceCircuitBreaker } from '../src/price-aggregation/source-circuit-breaker';
describe('provider outcome integration', () => {
  it('does not count schema failures as successful fetches', async () => {
    vi.mocked(httpClient.get).mockResolvedValue({ status: 200, data: { USD: { PRICE: 0 } } } as never);
    const source = new ChainlinkSource();
    for (let i = 0; i < 3; i++) {
      expect(await source.fetchWithOutcome('XLM')).toMatchObject({ price: null, failureKind: 'invalid-payload', failure: { category: 'invalid-payload', retryable: false } });
    }
    expect(source.health.totalFailures).toBe(3);
    expect(source.health.healthy).toBe(false);
    expect(source.health.lastSuccess).toBeNull();
    expect(sourceCircuitBreaker.recordSuccess).not.toHaveBeenCalled();
  });
  it('preserves the last validation failure after recovery', async () => {
    const source = new ChainlinkSource();
    vi.mocked(httpClient.get).mockResolvedValueOnce({ status: 200, data: { USD: { PRICE: 0 } } } as never);
    await source.fetchWithOutcome('XLM');
    const failedAt = source.lastInvalidPayloadAt;
    vi.mocked(httpClient.get).mockResolvedValueOnce({ status: 200, data: { USD: { PRICE: '0.12' } } } as never);
    expect((await source.fetchWithOutcome('XLM')).price).not.toBeNull();
    expect(source.lastInvalidPayloadAt).toBe(failedAt);
    expect(source.health.healthy).toBe(true);
  });
  it('returns no-price without marking a successful quote', async () => {
    vi.mocked(httpClient.get).mockResolvedValue({ status: 200, data: {} } as never);
    const source = new RedstoneSource();
    expect(await source.fetchWithOutcome('XLM')).toMatchObject({ failureKind: 'no-price', failure: { category: 'no-price' } });
    expect(source.health.lastSuccess).toBeNull();
  });
  it('does not retry authentication failures and retains legacy transport failure kind', async () => {
    vi.mocked(httpClient.get).mockRejectedValue({ response: { status: 401 }, code: 'ERR_BAD_REQUEST' });
    expect(await new ChainlinkSource().fetchWithOutcome('XLM')).toMatchObject({ failureKind: 'transport-error', failure: { category: 'authentication', retryable: false } });
    expect(httpClient.get).toHaveBeenCalledTimes(1);
  });
  it('retries transient transport errors then recovers', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(httpClient.get).mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValue({ status: 200, data: { USD: { PRICE: '0.12' } } } as never);
      const result = new ChainlinkSource().fetchWithOutcome('XLM');
      await vi.runAllTimersAsync();
      expect((await result).price?.price).toBe(12000000n);
      expect(httpClient.get).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
