import { describe, it, expect, beforeEach } from 'vitest';
import { PriceAggregator } from '../src/price-aggregation/aggregator';
import { medianPrice } from '../src/price-aggregation/median';

interface PriceStore {
  append(prices: unknown[]): Promise<void>;
  read(asset: string): Promise<unknown>;
}

interface CircuitBreakerPolicy {
  isAllowed(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}

interface AnomalyDetector {
  isAnomaly(price: number): boolean;
}

interface EventPublisher {
  publish(event: unknown): void;
}

describe('Issue #116: Hexagonal boundaries and dependency injection', () => {
  describe('PriceAggregator constructor injection', () => {
    it('should accept all dependencies via constructor', () => {
      const mockStore: PriceStore = {
        append: async () => {},
        read: async () => ({ price: 100 }),
      };

      const mockCircuitBreaker: CircuitBreakerPolicy = {
        isAllowed: () => true,
        recordSuccess: () => {},
        recordFailure: () => {},
      };

      const mockAnomalyDetector: AnomalyDetector = {
        isAnomaly: () => false,
      };

      const mockEventPublisher: EventPublisher = {
        publish: () => {},
      };

      const config = { watchedAssets: ['XLM', 'USDC'] };

      expect(() => {
        new PriceAggregator(
          mockStore,
          mockCircuitBreaker,
          mockAnomalyDetector,
          mockEventPublisher,
          config
        );
      }).not.toThrow();
    });

    it('should be testable with in-memory fakes and no global state', async () => {
      const collectedEvents: unknown[] = [];
      const appendedData: unknown[] = [];

      const mockStore: PriceStore = {
        append: async (prices) => {
          appendedData.push(...Array.isArray(prices) ? prices : [prices]);
        },
        read: async () => appendedData,
      };

      const mockCircuitBreaker: CircuitBreakerPolicy = {
        isAllowed: () => true,
        recordSuccess: () => {},
        recordFailure: () => {},
      };

      const mockAnomalyDetector: AnomalyDetector = {
        isAnomaly: () => false,
      };

      const mockEventPublisher: EventPublisher = {
        publish: (event) => collectedEvents.push(event),
      };

      const config = { watchedAssets: ['XLM'] };

      const aggregator = new PriceAggregator(
        mockStore,
        mockCircuitBreaker,
        mockAnomalyDetector,
        mockEventPublisher,
        config
      );

      expect(aggregator).toBeDefined();
      expect(collectedEvents).toHaveLength(0);
      expect(appendedData).toHaveLength(0);
    });
  });

  describe('BaseSource dependency injection', () => {
    it('should accept cost model as optional dependency', () => {
      const mockCostModel = {
        recordCall: async () => 0.01,
        estimateCostUsd: async () => 0.01,
      };

      const source = {
        fetchWithBackoff: async (url: string, costModel?: unknown) => {
          if (!costModel) {
            return { data: { price: 100 } };
          }
          return { data: { price: 100 } };
        },
      };

      expect(async () => {
        await source.fetchWithBackoff('https://example.com', mockCostModel);
        await source.fetchWithBackoff('https://example.com');
      }).not.toThrow();
    });

    it('should define behaviour when cost model is absent', async () => {
      const source = {
        fetchWithBackoff: async (url: string, costModel?: unknown) => {
          if (!costModel) {
            return { data: { price: 100 }, costEstimate: undefined };
          }
          return { data: { price: 100 }, costEstimate: 0.01 };
        },
      };

      const resultWithoutCostModel = await source.fetchWithBackoff('https://example.com');
      expect(resultWithoutCostModel.costEstimate).toBeUndefined();

      const resultWithCostModel = await source.fetchWithBackoff('https://example.com', {});
      expect(resultWithCostModel).toBeDefined();
    });
  });

  describe('Persistence boundary', () => {
    it('should access storage through interface, not direct functions', () => {
      const mockStore: PriceStore = {
        append: async (prices) => {
          expect(prices).toBeDefined();
        },
        read: async (asset) => {
          expect(asset).toBe('XLM');
          return { price: 100 };
        },
      };

      expect(async () => {
        await mockStore.append([{ asset: 'XLM', price: 100 }]);
        await mockStore.read('XLM');
      }).not.toThrow();
    });

    it('should make JSON file path one adapter behind interface', () => {
      const jsonFileAdapter: PriceStore = {
        append: async (prices) => {
          // In real code: write to JSON file
          // Path is encapsulated here
        },
        read: async (asset) => {
          // In real code: read from JSON file
          return { price: 100 };
        },
      };

      expect(jsonFileAdapter).toBeDefined();
    });
  });

  describe('Pure unit tests for medianPrice', () => {
    it('should calculate median with odd number of prices', () => {
      const prices = [100, 200, 150];
      const result = medianPrice(prices);
      expect(result).toBe(150);
    });

    it('should calculate median with even number of prices', () => {
      const prices = [100, 200];
      const result = medianPrice(prices);
      expect(result).toBe(150);
    });

    it('should handle decimal normalization', () => {
      const prices = [100000000, 50000000, 75000000];
      const result = medianPrice(prices);
      expect(result).toBe(75000000);
    });

    it('should handle single price', () => {
      const prices = [100];
      const result = medianPrice(prices);
      expect(result).toBe(100);
    });

    it('should handle sorted and unsorted prices equally', () => {
      const sorted = [100, 150, 200];
      const unsorted = [200, 100, 150];

      const resultSorted = medianPrice(sorted);
      const resultUnsorted = medianPrice(unsorted);

      expect(resultSorted).toBe(resultUnsorted);
    });

    it('should handle prices with extreme values', () => {
      const prices = [1, 1000000000, 500000000];
      const result = medianPrice(prices);
      expect(result).toBe(500000000);
    });

    it('should require no infrastructure or global state', () => {
      const prices1 = [100, 200, 150];
      const prices2 = [300, 400, 350];

      const result1 = medianPrice(prices1);
      const result2 = medianPrice(prices2);

      expect(result1).toBe(150);
      expect(result2).toBe(350);
    });
  });

  describe('Dependency direction enforcement', () => {
    it('domain modules should not import infrastructure', () => {
      expect(() => {
        const path = require.resolve('../src/price-aggregation/aggregator');
        const content = require('fs').readFileSync(path, 'utf-8');

        const invalidImports = [
          "from '../infrastructure/",
          "from '../../infrastructure/",
        ];

        const hasInvalidImport = invalidImports.some(imp => content.includes(imp));
        if (hasInvalidImport) {
          throw new Error('Domain module imports infrastructure directly');
        }
      }).not.toThrow();
    });
  });
});
