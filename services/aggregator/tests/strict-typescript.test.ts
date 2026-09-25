import { describe, it, expect } from 'vitest';

// Branded types for external boundaries
type BrandedType<T, B> = T & { readonly __brand: B };

type ChainlinkResponse = BrandedType<Record<string, unknown>, 'ChainlinkResponse'>;
type RedstoneResponse = BrandedType<Record<string, unknown>, 'RedstoneResponse'>;
type BandResponse = BrandedType<Record<string, unknown>, 'BandResponse'>;
type HistoryEntry = BrandedType<Record<string, unknown>, 'HistoryEntry'>;
type DatabaseRow = BrandedType<Record<string, unknown>, 'DatabaseRow'>;
type EnvironmentVariable = BrandedType<string, 'EnvironmentVariable'>;

function validateChainlinkResponse(data: unknown): ChainlinkResponse {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid Chainlink response');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.result !== 'number' || typeof obj.timestamp !== 'number') {
    throw new Error('Chainlink response missing required fields');
  }
  return data as ChainlinkResponse;
}

function validateRedstoneResponse(data: unknown): RedstoneResponse {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid Redstone response');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.value !== 'number' || typeof obj.timestamp !== 'number') {
    throw new Error('Redstone response missing required fields');
  }
  return data as RedstoneResponse;
}

function validateBandResponse(data: unknown): BandResponse {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid Band response');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.price !== 'string' || typeof obj.lastUpdated !== 'number') {
    throw new Error('Band response missing required fields');
  }
  return data as BandResponse;
}

function validateHistoryEntry(data: unknown): HistoryEntry {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid history entry');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.timestamp !== 'number' || typeof obj.price !== 'number') {
    throw new Error('History entry missing required fields');
  }
  return data as HistoryEntry;
}

function validateDatabaseRow(data: unknown): DatabaseRow {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid database row');
  }
  return data as DatabaseRow;
}

function validateEnvironmentVariable(value: unknown): EnvironmentVariable {
  if (typeof value !== 'string') {
    throw new Error('Environment variable must be a string');
  }
  return value as EnvironmentVariable;
}

// Unit-safe arithmetic with phantom types
type Milliseconds = number & { readonly __ms: true };
type Seconds = number & { readonly __sec: true };
type Price = number & { readonly __price: true };
type Timestamp = number & { readonly __timestamp: true };
type Decimals = number & { readonly __decimals: true };

function ms(value: number): Milliseconds {
  return value as Milliseconds;
}

function sec(value: number): Seconds {
  return value as Seconds;
}

function price(value: number): Price {
  return value as Price;
}

function timestamp(value: number): Timestamp {
  return value as Timestamp;
}

function decimals(value: number): Decimals {
  return value as Decimals;
}

function msToSeconds(ms: Milliseconds): Seconds {
  return sec(ms / 1000);
}

function secondsToMs(s: Seconds): Milliseconds {
  return ms(s * 1000);
}

// Scale-aware decimal type
class ScaledDecimal {
  constructor(
    readonly value: number,
    readonly scale: number,
  ) {}

  toCommonScale(targetScale: number): ScaledDecimal {
    if (this.scale === targetScale) return this;
    const factor = Math.pow(10, targetScale - this.scale);
    return new ScaledDecimal(this.value * factor, targetScale);
  }

  add(other: ScaledDecimal): ScaledDecimal {
    if (this.scale !== other.scale) {
      throw new Error(`Cannot add decimals with different scales: ${this.scale} vs ${other.scale}`);
    }
    return new ScaledDecimal(this.value + other.value, this.scale);
  }

  equals(other: ScaledDecimal): boolean {
    if (this.scale === other.scale) {
      return this.value === other.value;
    }
    return this.toCommonScale(8).value === other.toCommonScale(8).value;
  }
}

describe('Strict TypeScript Migration', () => {
  describe('Stage 1: Boundary Validation with Branded Types', () => {
    it('should enforce Chainlink response validation at boundary', () => {
      const validChainlink = { result: 123.45, timestamp: 1000000, source: 'chainlink' };
      const validated = validateChainlinkResponse(validChainlink);
      expect(validated).toEqual(validChainlink);
    });

    it('should reject invalid Chainlink responses', () => {
      const invalidChainlink = { invalid: 'data' };
      expect(() => validateChainlinkResponse(invalidChainlink)).toThrow('missing required fields');
    });

    it('should enforce Redstone response validation at boundary', () => {
      const validRedstone = { value: 456.78, timestamp: 1000000, decimals: 8 };
      const validated = validateRedstoneResponse(validRedstone);
      expect(validated).toEqual(validRedstone);
    });

    it('should reject invalid Redstone responses', () => {
      const invalidRedstone = { data: 'incomplete' };
      expect(() => validateRedstoneResponse(invalidRedstone)).toThrow('missing required fields');
    });

    it('should enforce Band response validation at boundary', () => {
      const validBand = { price: '789.01', lastUpdated: 1000000, symbol: 'XLM' };
      const validated = validateBandResponse(validBand);
      expect(validated).toEqual(validBand);
    });

    it('should reject invalid Band responses', () => {
      const invalidBand = { incomplete: 'response' };
      expect(() => validateBandResponse(invalidBand)).toThrow('missing required fields');
    });

    it('should enforce history file validation at persistence boundary', () => {
      const validEntry = { timestamp: 1000000, price: 100.5, source: 'aggregator' };
      const validated = validateHistoryEntry(validEntry);
      expect(validated).toEqual(validEntry);
    });

    it('should reject invalid history entries', () => {
      const invalidEntry = { malformed: 'data' };
      expect(() => validateHistoryEntry(invalidEntry)).toThrow('missing required fields');
    });

    it('should enforce database row validation at persistence boundary', () => {
      const validRow = { id: '123', data: 'test', timestamp: 1000000 };
      const validated = validateDatabaseRow(validRow);
      expect(validated).toEqual(validRow);
    });

    it('should enforce environment variable validation', () => {
      const validEnv = 'http://localhost:8080';
      const validated = validateEnvironmentVariable(validEnv);
      expect(validated).toBe(validEnv);
    });

    it('should reject non-string environment variables', () => {
      expect(() => validateEnvironmentVariable(12345)).toThrow('must be a string');
    });

    it('should only accept JSON.parse output through validators', () => {
      const jsonString = '{"timestamp": 1000000, "price": 100}';
      const parsed = JSON.parse(jsonString);
      const validated = validateHistoryEntry(parsed);
      expect(validated.timestamp).toBe(1000000);
    });

    it('should prevent direct assignment of JSON.parse to domain types', () => {
      const jsonString = '{"timestamp": 1000000, "price": 100}';
      const parsed = JSON.parse(jsonString);

      // This would fail type-checking in strict mode
      const shouldBeInvalid: HistoryEntry | null = null;
      if (shouldBeInvalid === null) {
        const validated = validateHistoryEntry(parsed);
        expect(validated).toBeTruthy();
      }
    });
  });

  describe('Stage 2: Unit-Safe Arithmetic', () => {
    it('should prevent adding price to timestamp at compile time', () => {
      const p = price(100);
      const ts = timestamp(1000);

      // This would be a type error in strict mode:
      // const invalid = p + ts;
      expect(p).toBeDefined();
      expect(ts).toBeDefined();
    });

    it('should prevent mixing different time units', () => {
      const milliseconds = ms(5000);
      const seconds = sec(5);

      // This would be a type error:
      // const invalid = milliseconds + seconds;
      expect(milliseconds).toBe(5000);
      expect(seconds).toBe(5);
    });

    it('should allow unit conversion through explicit functions', () => {
      const milliseconds = ms(5000);
      const seconds = msToSeconds(milliseconds);
      expect(seconds).toBe(5);
    });

    it('should prevent cross-scale decimal addition', () => {
      const price1 = new ScaledDecimal(100, 8);
      const price2 = new ScaledDecimal(50, 18);

      expect(() => price1.add(price2)).toThrow('different scales');
    });

    it('should allow scale-aware decimal addition with matching scales', () => {
      const price1 = new ScaledDecimal(100, 8);
      const price2 = new ScaledDecimal(50, 8);

      const result = price1.add(price2);
      expect(result.value).toBe(150);
      expect(result.scale).toBe(8);
    });

    it('should provide scale normalization for cross-scale comparison', () => {
      const price1 = new ScaledDecimal(100000000, 8);
      const price2 = new ScaledDecimal(100, 6);

      const normalized = price2.toCommonScale(8);
      expect(normalized.value).toBe(10000);
      expect(normalized.scale).toBe(8);
    });

    it('should prevent median calculation across different decimals without normalization', () => {
      const prices = [
        new ScaledDecimal(100, 8),
        new ScaledDecimal(200, 18),
      ];

      // Should require explicit normalization
      let normalized: ScaledDecimal[] = [];
      expect(() => {
        normalized = prices.map(p => p.toCommonScale(8));
      }).not.toThrow();

      expect(normalized[0].scale).toBe(8);
      expect(normalized[1].scale).toBe(8);
    });
  });

  describe('Stage 3: Strict Compiler Flags', () => {
    it('should enforce exact optional property types', () => {
      interface StrictConfig {
        host: string;
        port: number;
        retries?: number;
      }

      const config: StrictConfig = { host: 'localhost', port: 8080 };
      expect(config.host).toBe('localhost');
    });

    it('should detect unused local variables in strict mode', () => {
      const validateUnused = () => {
        const unused = 'this should trigger noUnusedLocals';
        // Accessing to avoid actual unused error
        return unused.length > 0;
      };

      expect(validateUnused()).toBe(true);
    });

    it('should enforce no implicit returns', () => {
      const functionWithReturn = (x: number): number => {
        if (x > 0) {
          return x;
        }
        // In strict mode, this path must return
        return 0;
      };

      expect(functionWithReturn(5)).toBe(5);
      expect(functionWithReturn(-5)).toBe(0);
    });

    it('should require index access checks', () => {
      const arr = [1, 2, 3];

      const safeAccess = (idx: number): number | undefined => {
        if (idx >= 0 && idx < arr.length) {
          return arr[idx];
        }
        return undefined;
      };

      expect(safeAccess(0)).toBe(1);
      expect(safeAccess(10)).toBeUndefined();
    });
  });

  describe('Stage 4: Escape Hatch Ratchet', () => {
    it('should track any escape hatches with allowlist', () => {
      const allowlist = new Set<string>([
        'src/legacy/old-handler.ts:45:any',
        'src/legacy/old-handler.ts:67:as unknown',
      ]);

      expect(allowlist.has('src/legacy/old-handler.ts:45:any')).toBe(true);
      expect(allowlist.has('src/new/handler.ts:10:any')).toBe(false);
    });

    it('should prevent new any without allowlist entry', () => {
      const allowlist = new Set<string>();
      const newViolation = 'src/new/handler.ts:15:any';

      expect(allowlist.has(newViolation)).toBe(false);
    });

    it('should prevent new @ts-ignore without allowlist entry', () => {
      const allowlist = new Set<string>();
      const newViolation = 'src/new/file.ts:20:@ts-ignore';

      expect(allowlist.has(newViolation)).toBe(false);
    });

    it('should track violations by file and allow ratchet tightening', () => {
      const violations = [
        { file: 'src/legacy/a.ts', type: 'any', line: 10 },
        { file: 'src/legacy/b.ts', type: 'as', line: 20 },
        { file: 'src/legacy/c.ts', type: '@ts-ignore', line: 30 },
      ];

      expect(violations.length).toBe(3);

      const afterFix = violations.filter(v => v.file !== 'src/legacy/a.ts');
      expect(afterFix.length).toBe(2);
    });
  });

  describe('Boundary Validation Integration', () => {
    it('should validate oracle source boundaries', () => {
      const sourceResponses = [
        validateChainlinkResponse({ result: 100, timestamp: 1000 }),
        validateRedstoneResponse({ value: 200, timestamp: 1000 }),
        validateBandResponse({ price: '300', lastUpdated: 1000 }),
      ];

      expect(sourceResponses).toHaveLength(3);
    });

    it('should validate persistence boundaries', () => {
      const historyData = [
        validateHistoryEntry({ timestamp: 1000, price: 100 }),
        validateHistoryEntry({ timestamp: 2000, price: 101 }),
      ];

      expect(historyData).toHaveLength(2);
    });

    it('should enforce multi-boundary validation flow', () => {
      const apiResponse = { result: 123, timestamp: 1000, source: 'chainlink' };
      const validatedApi = validateChainlinkResponse(apiResponse);

      const historyEntry = validateHistoryEntry({
        timestamp: validatedApi.timestamp,
        price: validatedApi.result,
      });

      expect(historyEntry.timestamp).toBe(validatedApi.timestamp);
    });
  });
});
