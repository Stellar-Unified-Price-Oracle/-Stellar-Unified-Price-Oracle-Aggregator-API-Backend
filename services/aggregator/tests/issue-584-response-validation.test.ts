import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import {
  parseProviderResponse,
  scaleValidatedPrice,
  reportInvalidPayload,
  type ProviderSchemaName,
} from '../src/oracle-sources/response-validation';

const FIXTURES_DIR = path.join(__dirname, 'fixtures/oracle-payloads');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
}

/** All recorded payloads for one provider, keyed by the fixture class. */
function fixturesFor(provider: ProviderSchemaName): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const file of readdirSync(FIXTURES_DIR)) {
    if (file.startsWith(`${provider}-`)) {
      out[file.replace(`${provider}-`, '').replace('.json', '')] = loadFixture(file);
    }
  }
  return out;
}

vi.mock('../src/observability/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('Provider response validation (#584) — recorded fixtures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('chainlink', () => {
    const schema: ProviderSchemaName = 'chainlink';
    const fixtures = fixturesFor('chainlink');

    it('accepts a valid payload', () => {
      const result = parseProviderResponse(schema, fixtures['valid'], 'XLM');
      expect(result).toMatchObject({ kind: 'ok', decimals: 8, observedAt: null });
    });

    it('classifies a missing field as invalid-payload', () => {
      const result = parseProviderResponse(schema, fixtures['missing-field'], 'XLM');
      expect(result.kind).toBe('invalid-payload');
    });

    it('classifies a wrong type as invalid-payload', () => {
      const result = parseProviderResponse(schema, fixtures['wrong-type'], 'XLM');
      expect(result.kind).toBe('invalid-payload');
    });

    it('classifies an error envelope with HTTP 200 as invalid-payload', () => {
      const result = parseProviderResponse(schema, fixtures['error-envelope-200'], 'XLM');
      expect(result.kind).toBe('invalid-payload');
      expect(result.issues).toBeTruthy();
    });

    it('classifies zero/NaN/negative prices as invalid-payload', () => {
      for (const key of ['zero-price', 'nan-price', 'negative-price']) {
        expect(parseProviderResponse(schema, fixtures[key], 'XLM').kind).toBe('invalid-payload');
      }
    });
  });

  describe('redstone', () => {
    const schema: ProviderSchemaName = 'redstone';
    const fixtures = fixturesFor('redstone');

    it('accepts a valid payload', () => {
      const result = parseProviderResponse(schema, fixtures['valid'], 'XLM');
      expect(result).toMatchObject({ kind: 'ok', decimals: 8 });
    });

    it('classifies a missing field as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['missing-field'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies a wrong type as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['wrong-type'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies an error envelope with HTTP 200 as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['error-envelope-200'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies zero/NaN prices as invalid-payload', () => {
      for (const key of ['zero-price', 'nan-price']) {
        expect(parseProviderResponse(schema, fixtures[key], 'XLM').kind).toBe('invalid-payload');
      }
    });

    it('treats an asset the provider does not carry as no-price, not a violation', () => {
      expect(parseProviderResponse(schema, fixtures['asset-not-carried'], 'XLM')).toMatchObject({
        kind: 'no-price',
      });
    });

    it('accepts a legitimate decimals of 0 instead of replacing it with the default', () => {
      const result = parseProviderResponse(schema, fixtures['zero-decimals'], 'XLM');
      expect(result).toMatchObject({ kind: 'ok', decimals: 0 });
    });

    it('rejects out-of-range decimals', () => {
      expect(parseProviderResponse(schema, fixtures['out-of-range-decimals'], 'XLM').kind).toBe('invalid-payload');
    });
  });

  describe('band', () => {
    const schema: ProviderSchemaName = 'band';
    const fixtures = fixturesFor('band');

    it('accepts a valid payload and keeps the provider observation time', () => {
      const result = parseProviderResponse(schema, fixtures['valid'], 'XLM');
      expect(result).toMatchObject({ kind: 'ok', decimals: 9, observedAt: 1727654400 });
    });

    it('classifies a missing field as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['missing-field'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies a wrong type as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['wrong-type'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies an error envelope with HTTP 200 as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['error-envelope-200'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies zero/NaN prices as invalid-payload', () => {
      for (const key of ['zero-price', 'nan-price']) {
        expect(parseProviderResponse(schema, fixtures[key], 'XLM').kind).toBe('invalid-payload');
      }
    });

    it('treats a null feed envelope as no-price, not a violation', () => {
      expect(parseProviderResponse(schema, fixtures['null-data'], 'XLM')).toMatchObject({ kind: 'no-price' });
    });

    it('accepts a legitimate decimals of 0 instead of replacing it with the default', () => {
      const result = parseProviderResponse(schema, fixtures['zero-decimals'], 'XLM');
      expect(result).toMatchObject({ kind: 'ok', decimals: 0 });
    });

    it('rejects out-of-range decimals', () => {
      expect(parseProviderResponse(schema, fixtures['out-of-range-decimals'], 'XLM').kind).toBe('invalid-payload');
    });
  });

  describe('reflector', () => {
    const schema: ProviderSchemaName = 'reflector';
    const fixtures = fixturesFor('reflector');

    it('accepts a valid payload and keeps the provider observation time', () => {
      const result = parseProviderResponse(schema, fixtures['valid'], 'XLM');
      expect(result).toMatchObject({ kind: 'ok', decimals: 8, observedAt: 1727654400 });
    });

    it('classifies a missing field as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['missing-field'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies a wrong type as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['wrong-type'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies an error envelope with HTTP 200 as invalid-payload', () => {
      expect(parseProviderResponse(schema, fixtures['error-envelope-200'], 'XLM').kind).toBe('invalid-payload');
    });

    it('classifies zero/NaN prices as invalid-payload', () => {
      for (const key of ['zero-price', 'nan-price']) {
        expect(parseProviderResponse(schema, fixtures[key], 'XLM').kind).toBe('invalid-payload');
      }
    });

    it('treats an asset the provider does not carry as no-price, not a violation', () => {
      expect(parseProviderResponse(schema, fixtures['asset-not-carried'], 'XLM')).toMatchObject({
        kind: 'no-price',
      });
    });

    it('accepts a legitimate decimals of 0 instead of replacing it with the default', () => {
      const result = parseProviderResponse(schema, fixtures['zero-decimals'], 'XLM');
      expect(result).toMatchObject({ kind: 'ok', decimals: 0 });
    });

    it('rejects out-of-range decimals', () => {
      expect(parseProviderResponse(schema, fixtures['out-of-range-decimals'], 'XLM').kind).toBe('invalid-payload');
    });
  });

  describe('scaleValidatedPrice', () => {
    it('scales valid prices with 0 decimals (no ||-default replacement)', () => {
      expect(scaleValidatedPrice('39870', 0)).toEqual({ ok: true, scaled: 39870n });
    });

    it('rejects non-finite and non-positive values before BigInt can throw', () => {
      for (const [price, decimals] of [
        [NaN, 8],
        [Infinity, 8],
        [0, 8],
        ['NaN', 8],
        [-1, 8],
      ] as [number | string, number][]) {
        expect(scaleValidatedPrice(price, decimals).ok).toBe(false);
      }
    });

    it('rejects decimals outside [0, 18] before scaling', () => {
      expect(scaleValidatedPrice('1', 19).ok).toBe(false);
      expect(scaleValidatedPrice('1', -1).ok).toBe(false);
    });

    it('keeps full precision for large prices at 18 decimals (wei-denominated feeds)', () => {
      const result = scaleValidatedPrice('3500000000000000000000', 18);
      expect(result).toEqual({ ok: true, scaled: 3500000000000000000000000000000000000000n });
    });

    it('scales any finite value without throwing — out-of-range prices fail later at the contract boundary', () => {
      // Parity with the original normalize(): BigNumber is arbitrary-precision,
      // so a huge-but-finite price scales; i128 bounds are enforced by the
      // publisher, not by the scaling step.
      expect(scaleValidatedPrice('1e300', 18).ok).toBe(true);
    });

    it('scales a realistic price correctly', () => {
      expect(scaleValidatedPrice('0.3987', 8)).toEqual({ ok: true, scaled: 39870000n });
    });
  });

  describe('reportInvalidPayload', () => {
    it('logs a payload preview for debugging a schema change without throwing', () => {
      const result = parseProviderResponse('chainlink', fixturesFor('chainlink')['error-envelope-200'], 'XLM');
      expect(result.kind).toBe('invalid-payload');
      expect(() =>
        reportInvalidPayload('chainlink', 'XLM', result as never, { huge: 'x'.repeat(1000) }),
      ).not.toThrow();
    });
  });
});
