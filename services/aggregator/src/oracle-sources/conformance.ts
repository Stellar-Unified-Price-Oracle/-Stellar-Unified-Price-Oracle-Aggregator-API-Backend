import { parseProviderResponse, type ProviderFetchResult } from './response-validation';
import { OracleSourceName } from '../infrastructure/types';
import { logger } from '../observability/logger';

/**
 * Issue #683 — Independent source conformance suite.
 *
 * Provider-neutral golden vectors and contract tests. Each adapter must pass
 * the full suite before it can contribute to production feeds. The suite is
 * intentionally decoupled from any transport: it replays recorded provider
 * payloads through `parseProviderResponse` and asserts the classified outcome
 * (`ok` / `no-price` / `invalid-payload`) matches the expected contract.
 *
 * A provider that fails any vector is considered non-conformant and must be
 * removed from the poll loop until the adapter is fixed.
 */

export interface ConformanceVector {
  provider: OracleSourceName;
  /** Stable vector id, referenced by failures and regression records. */
  id: string;
  /** Human-readable description of the contract case. */
  description: string;
  /** Raw provider payload to replay. */
  payload: unknown;
  /** Asset the payload was requested for. */
  asset: string;
  /** Expected classification of the payload. */
  expected: 'ok' | 'no-price' | 'invalid-payload';
  /** When `ok`, the expected normalized decimals. */
  expectedDecimals?: number;
  /** Whether this vector blocks production contribution when failed. */
  blocking: boolean;
}

export interface ConformanceResult {
  provider: OracleSourceName;
  vectorId: string;
  description: string;
  passed: boolean;
  blocking: boolean;
  actual: ProviderFetchResult['kind'] | 'error';
  expected: ConformanceVector['expected'];
  expectedDecimals?: number;
  actualDecimals?: number;
  error?: string;
}

export interface ConformanceReport {
  provider: OracleSourceName;
  total: number;
  passed: number;
  failed: number;
  blockingFailed: number;
  results: ConformanceResult[];
  conformant: boolean;
}

/**
 * Replays a single golden vector against its provider's schema and returns a
 * typed result. Transport errors surface as `actual: 'error'`.
 */
function runVector(vector: ConformanceVector): ConformanceResult {
  let actual: ProviderFetchResult['kind'] | 'error';
  let actualDecimals: number | undefined;
  let error: string | undefined;

  try {
    const result = parseProviderResponse(vector.provider, vector.payload, vector.asset);
    actual = result.kind;
    if (result.kind === 'ok') actualDecimals = result.decimals;
  } catch (err) {
    actual = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  const passed =
    actual === vector.expected &&
    (vector.expectedDecimals === undefined || actualDecimals === vector.expectedDecimals);

  return {
    provider: vector.provider,
    vectorId: vector.id,
    description: vector.description,
    passed,
    blocking: vector.blocking,
    actual,
    expected: vector.expected,
    expectedDecimals: vector.expectedDecimals,
    actualDecimals,
    error,
  };
}

/**
 * Runs every registered vector for one provider and produces a report. A
 * provider is conformant only when all blocking vectors pass.
 */
export class SourceConformanceSuite {
  private vectors: ConformanceVector[] = [];

  addVector(vector: ConformanceVector): void {
    this.vectors.push(vector);
  }

  addVectors(vectors: ConformanceVector[]): void {
    this.vectors.push(...vectors);
  }

  listVectors(): ConformanceVector[] {
    return [...this.vectors];
  }

  runForProvider(provider: OracleSourceName): ConformanceReport {
    const results = this.vectors
      .filter((v) => v.provider === provider)
      .map((v) => runVector(v));

    const failed = results.filter((r) => !r.passed);
    const blockingFailed = failed.filter((r) => r.blocking).length;

    return {
      provider,
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      blockingFailed,
      results,
      conformant: blockingFailed === 0,
    };
  }

  run(): Map<OracleSourceName, ConformanceReport> {
    const providers: OracleSourceName[] = ['chainlink', 'redstone', 'band', 'reflector'];
    const report = new Map<OracleSourceName, ConformanceReport>();
    for (const provider of providers) {
      report.set(provider, this.runForProvider(provider));
    }
    return report;
  }
}

/** Singleton suite shared by the conformance tests and the preflight check. */
export const conformanceSuite = new SourceConformanceSuite();

/**
 * Default golden vectors for each provider. These are the provider-neutral
 * contract every adapter must honor. Vectors mirror the recorded fixtures in
 * `tests/fixtures/oracle-payloads` so a recorded schema change is caught by
 * both the unit fixtures and the conformance suite.
 */
export const DEFAULT_VECTORS: ConformanceVector[] = [
  // chainlink
  {
    provider: 'chainlink',
    id: 'chainlink-valid',
    description: 'valid chainlink price envelope is accepted at 8 decimals',
    payload: { USD: { PRICE: '3987.50' } },
    asset: 'XLM',
    expected: 'ok',
    expectedDecimals: 8,
    blocking: true,
  },
  {
    provider: 'chainlink',
    id: 'chainlink-missing-field',
    description: 'chainlink payload missing USD.PRICE is invalid-payload',
    payload: { USD: {} },
    asset: 'XLM',
    expected: 'invalid-payload',
    blocking: true,
  },
  {
    provider: 'chainlink',
    id: 'chainlink-zero-price',
    description: 'chainlink zero price is invalid-payload',
    payload: { USD: { PRICE: 0 } },
    asset: 'XLM',
    expected: 'invalid-payload',
    blocking: true,
  },
  // redstone
  {
    provider: 'redstone',
    id: 'redstone-valid',
    description: 'valid redstone entry is accepted with reported decimals',
    payload: { XLM: { value: '3987.50', decimals: 8 } },
    asset: 'XLM',
    expected: 'ok',
    expectedDecimals: 8,
    blocking: true,
  },
  {
    provider: 'redstone',
    id: 'redstone-asset-not-carried',
    description: 'redstone asset not carried is no-price, not a violation',
    payload: { USDC: { value: '1.0', decimals: 6 } },
    asset: 'XLM',
    expected: 'no-price',
    blocking: true,
  },
  {
    provider: 'redstone',
    id: 'redstone-missing-decimals',
    description: 'redstone entry without decimals is accepted by parseProviderResponse (strict reported-policy check lives in resolveDecimals)',
    payload: { XLM: { value: '3987.50' } },
    asset: 'XLM',
    expected: 'ok',
    expectedDecimals: 8,
    blocking: true,
  },
  {
    provider: 'redstone',
    id: 'redstone-zero-price',
    description: 'redstone zero price is invalid-payload',
    payload: { XLM: { value: 0, decimals: 8 } },
    asset: 'XLM',
    expected: 'invalid-payload',
    blocking: true,
  },
  // band
  {
    provider: 'band',
    id: 'band-valid',
    description: 'band feed data is accepted with provider timestamp',
    payload: { data: { price: '3987.50', decimals: 8, updated_at: 1700000000 } },
    asset: 'XLM',
    expected: 'ok',
    expectedDecimals: 8,
    blocking: true,
  },
  {
    provider: 'band',
    id: 'band-null-data',
    description: 'band null feed data is no-price (feed absent), not a schema violation',
    payload: { data: null },
    asset: 'XLM',
    expected: 'no-price',
    blocking: true,
  },
  {
    provider: 'band',
    id: 'band-out-of-range-decimals',
    description: 'band decimals outside contract range is invalid-payload',
    payload: { data: { price: '1', decimals: 19 } },
    asset: 'XLM',
    expected: 'invalid-payload',
    blocking: true,
  },
  // reflector
  {
    provider: 'reflector',
    id: 'reflector-valid',
    description: 'reflector price entry is accepted',
    payload: { prices: { 'Crypto.XLM/USD': { price: '3987.50', decimals: 8, timestamp: 1700000000 } } },
    asset: 'XLM',
    expected: 'ok',
    expectedDecimals: 8,
    blocking: true,
  },
  {
    provider: 'reflector',
    id: 'reflector-missing-field',
    description: 'reflector missing price field is invalid-payload',
    payload: { prices: { 'Crypto.XLM/USD': { decimals: 8 } } },
    asset: 'XLM',
    expected: 'invalid-payload',
    blocking: true,
  },
  {
    provider: 'reflector',
    id: 'reflector-asset-not-carried',
    description: 'reflector asset not present is no-price',
    payload: { prices: { 'Crypto.USDC/USD': { price: '1.0', decimals: 6 } } },
    asset: 'XLM',
    expected: 'no-price',
    blocking: true,
  },
];

for (const vector of DEFAULT_VECTORS) {
  conformanceSuite.addVector(vector);
}

logger.info('[Conformance] Default golden vectors loaded', {
  vectorCount: DEFAULT_VECTORS.length,
});
