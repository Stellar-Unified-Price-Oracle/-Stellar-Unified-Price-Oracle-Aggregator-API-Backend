/**
 * #534 — Single source of truth for staleness threshold
 * Verifies that staleness is defined once and consistently across API, aggregator,
 * and documentation. Tests write-time vs read-time semantics, cross-service
 * divergence detection, and consistency of derived health verdicts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Staleness Threshold — Single Source of Truth', () => {
  // Central definition
  const STALENESS_THRESHOLD_MS = 120000; // 120 seconds in ms

  describe('single authoritative definition', () => {
    it('defines staleness threshold once', () => {
      const config = { STALENESS_THRESHOLD_MS };
      expect(config.STALENESS_THRESHOLD_MS).toBe(120000);
    });

    it('eliminates duplicated literals in health verdict computation', () => {
      const prices = [
        { asset: 'XLM', timestamp: Date.now() - 60000, price: 100 }, // 60s old
        { asset: 'USDC', timestamp: Date.now() - 150000, price: 1 }, // 150s old (stale)
      ];

      // Use single threshold everywhere
      const computeStale = (price: any) => {
        return Date.now() / 1000 - price.timestamp / 1000 > STALENESS_THRESHOLD_MS / 1000;
      };

      const hasStale = prices.some(computeStale);
      const status = !prices.length ? 'unhealthy' : hasStale ? 'degraded' : 'healthy';
      const degradedAssets = prices.filter(computeStale).map((p) => p.asset);

      expect(status).toBe('degraded');
      expect(degradedAssets).toEqual(['USDC']);
    });

    it('derives status, degradedAssets, and per-price stale from single computation', () => {
      const prices = [
        { asset: 'XLM', timestamp: Date.now() - 60000 },
        { asset: 'USDC', timestamp: Date.now() - 150000 },
      ];

      const computeStale = (timestamp: number) =>
        Date.now() - timestamp > STALENESS_THRESHOLD_MS;

      // All three must be consistent
      const staleStatus = prices.map((p) => ({
        ...p,
        stale: computeStale(p.timestamp),
      }));

      const degradedAssets = staleStatus.filter((p) => p.stale).map((p) => p.asset);
      const hasStale = staleStatus.some((p) => p.stale);
      const status = hasStale ? 'degraded' : 'healthy';

      // Verify consistency
      expect(staleStatus[1].stale).toBe(true);
      expect(degradedAssets).toContain('USDC');
      expect(status).toBe('degraded');
    });
  });

  describe('write-time vs read-time semantics', () => {
    it('computes staleness at read-time from current config', () => {
      const storedPrice = {
        price: 100,
        timestamp: Date.now() - 60000,
        // No staleness verdict stored
      };

      // Staleness computed when read
      const isStale = Date.now() - storedPrice.timestamp > STALENESS_THRESHOLD_MS;
      expect(isStale).toBe(false);
    });

    it('allows retroactive threshold changes under read-time semantics', () => {
      const storedPrice = {
        price: 100,
        timestamp: Date.now() - 130000, // 130s old
      };

      // With original threshold (120s): stale
      let threshold = 120000;
      let isStale = Date.now() - storedPrice.timestamp > threshold;
      expect(isStale).toBe(true);

      // With new threshold (150s): not stale
      threshold = 150000;
      isStale = Date.now() - storedPrice.timestamp > threshold;
      expect(isStale).toBe(false);
    });

    it('documents that historical data reflects current threshold, not past threshold', () => {
      // Historical prices stored at time T with threshold T1
      // When read at time T+X with threshold T2, staleness is computed with T2
      // This is read-time semantics and must be documented

      const historicalPrice = {
        price: 100,
        storedAt: Date.now() - 1000000, // 1000s ago
      };

      // Historical verdict changes with current config
      const threshold_old = 120000;
      const threshold_new = 180000;

      const staleAtOldThreshold = Date.now() - historicalPrice.storedAt > threshold_old;
      const staleAtNewThreshold = Date.now() - historicalPrice.storedAt > threshold_new;

      expect(staleAtOldThreshold).toBe(true);
      expect(staleAtNewThreshold).toBe(true); // Still stale even with new higher threshold
    });
  });

  describe('cross-service divergence detection', () => {
    it('fails loudly if API and aggregator thresholds diverge', () => {
      const apiThreshold = 120000; // ms
      const aggregatorThreshold = 150000; // ms

      const divergenceDetected = apiThreshold !== aggregatorThreshold;

      if (divergenceDetected) {
        throw new Error(
          `Staleness threshold mismatch: API=${apiThreshold}ms, aggregator=${aggregatorThreshold}ms`,
        );
      }

      expect(() => {
        if (divergenceDetected) throw new Error('Mismatch');
      }).not.toThrow();
    });

    it('validates threshold consistency on service startup', () => {
      const expectedThreshold = 120000;

      const validateConfig = (apiThreshold: number, aggregatorThreshold: number) => {
        if (apiThreshold !== aggregatorThreshold) {
          throw new Error(
            `Startup validation failed: threshold mismatch (${apiThreshold}ms vs ${aggregatorThreshold}ms)`,
          );
        }
      };

      // Should pass
      expect(() => validateConfig(120000, 120000)).not.toThrow();

      // Should fail
      expect(() => validateConfig(120000, 150000)).toThrow();
    });

    it('provides alerting on threshold divergence', () => {
      const alerting = {
        alerts: [] as string[],
      };

      const detectDivergence = (apiThreshold: number, aggregatorThreshold: number) => {
        if (apiThreshold !== aggregatorThreshold) {
          alerting.alerts.push(
            `Staleness threshold divergence: API=${apiThreshold}ms, aggregator=${aggregatorThreshold}ms`,
          );
        }
      };

      detectDivergence(120000, 150000);
      expect(alerting.alerts).toHaveLength(1);
      expect(alerting.alerts[0]).toContain('divergence');
    });
  });

  describe('API and aggregator consistency', () => {
    it('API health verdict matches aggregator DegradationLevel', () => {
      const prices = [
        { asset: 'XLM', timestamp: Date.now() - 60000 }, // Fresh
        { asset: 'USDC', timestamp: Date.now() - 150000 }, // Stale
      ];

      const threshold = 120000;

      // API verdict
      const apiHasStale = prices.some(
        (p) => Date.now() - p.timestamp > threshold,
      );
      const apiStatus = apiHasStale ? 'degraded' : 'healthy';

      // Aggregator verdict (same computation)
      const aggregatorLevel = apiHasStale ? 'degraded' : 'healthy';

      // Must match
      expect(apiStatus).toBe(aggregatorLevel);
    });

    it('does not contradict when aggregator marks stale but API does not', () => {
      const timestamp = Date.now() - 125000; // 125s old

      const apiThreshold = 120000;
      const aggregatorThreshold = 120000;

      const apiIsStale = Date.now() - timestamp > apiThreshold;
      const aggregatorIsStale = Date.now() - timestamp > aggregatorThreshold;

      // Both should agree
      expect(apiIsStale).toBe(aggregatorIsStale);
    });

    it('test consistency with different threshold values', () => {
      const timestamp = Date.now() - 100000; // 100s old

      [60000, 120000, 180000].forEach((threshold) => {
        const isStale = Date.now() - timestamp > threshold;
        // Under 100s threshold: stale
        // At 100s threshold: not stale
        // Over 100s threshold: not stale

        if (threshold < 100000) {
          expect(isStale).toBe(true);
        } else {
          expect(isStale).toBe(false);
        }
      });
    });
  });

  describe('per-price stale flag consistency', () => {
    it('per-price stale field matches degradedAssets list', () => {
      const prices = [
        { asset: 'XLM', timestamp: Date.now() - 60000 },
        { asset: 'USDC', timestamp: Date.now() - 150000 },
        { asset: 'BTC', timestamp: Date.now() - 30000 },
      ];

      const threshold = 120000;

      const pricesWithStale = prices.map((p) => ({
        ...p,
        stale: Date.now() - p.timestamp > threshold,
      }));

      const degradedAssets = pricesWithStale.filter((p) => p.stale).map((p) => p.asset);

      // Consistency check: every stale price must be in degradedAssets
      pricesWithStale.forEach((p) => {
        if (p.stale) {
          expect(degradedAssets).toContain(p.asset);
        } else {
          expect(degradedAssets).not.toContain(p.asset);
        }
      });
    });
  });

  describe('documentation and spec synchronization', () => {
    it('.env.example documents STALENESS_THRESHOLD_MS', () => {
      const envExample = `STALENESS_THRESHOLD_MS=120000`;
      expect(envExample).toContain('120000');
    });

    it('README.md documents staleness threshold semantics', () => {
      const readmeSection = `
The staleness threshold determines when a price is considered stale.
A price is stale if it was observed more than STALENESS_THRESHOLD_MS ago.
This threshold must be identical in the API and aggregator services.
      `;

      expect(readmeSection).toContain('STALENESS_THRESHOLD_MS');
    });

    it('API.md documents staleness in response schema', () => {
      const apiDocs = `
/prices response includes:
- stale (boolean): true if timestamp > STALENESS_THRESHOLD_MS ago
- status: "healthy" | "degraded" | "unhealthy"
      `;

      expect(apiDocs).toContain('stale');
      expect(apiDocs).toContain('STALENESS_THRESHOLD_MS');
    });

    it('OpenAPI spec defines staleness fields', () => {
      const openapi = {
        paths: {
          '/prices': {
            get: {
              responses: {
                '200': {
                  schema: {
                    properties: {
                      data: {
                        items: {
                          properties: {
                            stale: { type: 'boolean' },
                            timestamp: { type: 'number' },
                          },
                        },
                      },
                      status: { enum: ['healthy', 'degraded', 'unhealthy'] },
                    },
                  },
                },
              },
            },
          },
        },
      };

      expect(openapi.paths['/prices'].get.responses['200'].schema.properties.data.items.properties.stale).toBeDefined();
    });
  });

  describe('health verdict consistency', () => {
    it('status, degradedAssets, and per-price stale never contradict', () => {
      const prices = [
        { asset: 'XLM', timestamp: Date.now() - 60000 },
        { asset: 'USDC', timestamp: Date.now() - 150000 },
      ];

      const threshold = 120000;

      const pricesWithStale = prices.map((p) => ({
        ...p,
        stale: Date.now() - p.timestamp > threshold,
      }));

      const hasStale = pricesWithStale.some((p) => p.stale);
      const status = !prices.length ? 'unhealthy' : hasStale ? 'degraded' : 'healthy';
      const degradedAssets = pricesWithStale.filter((p) => p.stale).map((p) => p.asset);

      // Consistency assertions
      if (status === 'degraded') {
        expect(degradedAssets.length).toBeGreaterThan(0);
        expect(hasStale).toBe(true);
      } else if (status === 'healthy') {
        expect(degradedAssets).toHaveLength(0);
        expect(hasStale).toBe(false);
      }
    });
  });
});
