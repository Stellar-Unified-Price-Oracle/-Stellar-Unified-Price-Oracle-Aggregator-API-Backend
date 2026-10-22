import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SourceConformanceSuite,
  conformanceSuite,
  DEFAULT_VECTORS,
  type ConformanceReport,
} from '../src/oracle-sources/conformance';
import { OracleSourceName } from '../src/infrastructure/types';

vi.mock('../src/observability/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('Issue #683 — Source conformance suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('SourceConformanceSuite', () => {
    it('passes a conforming provider across all blocking vectors', () => {
      const suite = new SourceConformanceSuite();
      suite.addVectors([
        {
          provider: 'chainlink',
          id: 'cl-valid',
          description: 'valid payload',
          payload: { USD: { PRICE: '1' } },
          asset: 'XLM',
          expected: 'ok',
          expectedDecimals: 8,
          blocking: true,
        },
        {
          provider: 'chainlink',
          id: 'cl-no-price',
          description: 'asset not carried',
          payload: { USD: { PRICE: '1' } },
          asset: 'DOGE',
          expected: 'ok',
          expectedDecimals: 8,
          blocking: true,
        },
      ]);
      const report = suite.runForProvider('chainlink');
      expect(report.conformant).toBe(true);
      expect(report.blockingFailed).toBe(0);
    });

    it('fails when a blocking vector does not match the expected outcome', () => {
      const suite = new SourceConformanceSuite();
      suite.addVector({
        provider: 'redstone',
        id: 'rs-bad',
        description: 'should be ok but expects invalid',
        payload: { XLM: { value: '1', decimals: 8 } },
        asset: 'XLM',
        expected: 'invalid-payload',
        blocking: true,
      });
      const report = suite.runForProvider('redstone');
      expect(report.conformant).toBe(false);
      expect(report.blockingFailed).toBe(1);
      expect(report.results[0].passed).toBe(false);
      expect(report.results[0].actual).toBe('ok');
    });

    it('does not fail the suite when a non-blocking vector fails', () => {
      const suite = new SourceConformanceSuite();
      suite.addVector({
        provider: 'band',
        id: 'bn-nonblocking',
        description: 'non-blocking failure',
        payload: { data: null },
        asset: 'XLM',
        expected: 'ok',
        blocking: false,
      });
      const report = suite.runForProvider('band');
      expect(report.conformant).toBe(true);
      expect(report.failed).toBe(1);
      expect(report.blockingFailed).toBe(0);
    });

    it('treats an unparseable payload as a failed vector', () => {
      const suite = new SourceConformanceSuite();
      suite.addVector({
        provider: 'reflector',
        id: 'rf-undef',
        description: 'undefined payload is classified invalid-payload',
        payload: undefined as unknown,
        asset: 'XLM',
        expected: 'ok',
        blocking: true,
      });
      const report = suite.runForProvider('reflector');
      expect(report.results[0].actual).toBe('invalid-payload');
      expect(report.results[0].passed).toBe(false);
      expect(report.conformant).toBe(false);
    });
  });

  describe('Default golden vectors', () => {
    it('covers all four providers with blocking vectors', () => {
      const providers = new Set(DEFAULT_VECTORS.map((v) => v.provider));
      for (const p of ['chainlink', 'redstone', 'band', 'reflector'] as OracleSourceName[]) {
        expect(providers.has(p)).toBe(true);
      }
      const blockingByProvider = new Map<string, number>();
      for (const v of DEFAULT_VECTORS) {
        if (v.blocking) {
          blockingByProvider.set(
            v.provider,
            (blockingByProvider.get(v.provider) ?? 0) + 1,
          );
        }
      }
      for (const p of providers) {
        expect(blockingByProvider.get(p)).toBeGreaterThan(0);
      }
    });

    it('certifies normalized scale and provider timestamp semantics for every valid vector', () => {
      for (const vector of DEFAULT_VECTORS.filter((item) => item.expected === 'ok')) {
        const result = conformanceSuite.runForProvider(vector.provider).results.find((item) => item.vectorId === vector.id);
        expect(result?.passed, vector.id).toBe(true);
        expect(result?.actualDecimals).toBeGreaterThanOrEqual(0);
        expect(result?.actualScaledPrice).toMatch(/^\d+$/);
        expect(result?.actualObservedAt).toBe(vector.expectedObservedAt ?? null);
      }
    });

    it('the shared suite reports every provider as conformant', () => {
      const report = conformanceSuite.run();
      for (const [provider, r] of report) {
        expect(r.conformant, `${provider} should be conformant`).toBe(true);
        expect(r.blockingFailed).toBe(0);
      }
    });

    it('reports a per-provider ConformanceReport shape', () => {
      const report = conformanceSuite.runForProvider('chainlink');
      const keys: (keyof ConformanceReport)[] = [
        'provider',
        'total',
        'passed',
        'failed',
        'blockingFailed',
        'results',
        'conformant',
      ];
      for (const key of keys) expect(key in report).toBe(true);
      expect(report.provider).toBe('chainlink');
      expect(report.total).toBeGreaterThan(0);
    });
  });
});
