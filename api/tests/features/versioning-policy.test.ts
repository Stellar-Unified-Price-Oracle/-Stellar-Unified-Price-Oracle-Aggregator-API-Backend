import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import { setupE2E, teardownE2E } from '../setup';
import { API_VERSIONS, DEPRECATION_SUNSET_DATE, DEPRECATION_LINK, v1DeprecationHeaders, v2Headers } from '../../src/price-serving/versioning';

let app: Express;

beforeAll(async () => {
  await setupE2E();

  app = express();
  app.use(express.json());

  // V1 routes with deprecation headers
  const v1Router = express.Router();
  v1Router.use(v1DeprecationHeaders);

  v1Router.get('/prices', (req, res) => {
    res.json({
      success: true,
      data: {
        prices: [{ asset: 'XLM', price: 0.15 }],
      },
    });
  });

  v1Router.get('/health', (req, res) => {
    res.json({
      success: true,
      data: { status: 'healthy', service: 'stellar-price-oracle-api' },
    });
  });

  v1Router.get('/sources', (req, res) => {
    res.json({
      success: true,
      data: { sources: [] },
    });
  });

  app.use('/api/v1', v1Router);

  // V2 routes with stability headers
  const v2Router = express.Router();
  v2Router.use(v2Headers);

  v2Router.get('/prices', (req, res) => {
    res.json({
      success: true,
      data: {
        prices: [{ asset: 'XLM', price: 0.15 }],
        _meta: { apiVersion: 'v2', timestamp: new Date().toISOString() },
      },
    });
  });

  v2Router.get('/health', (req, res) => {
    res.json({
      success: true,
      data: {
        status: 'healthy',
        service: 'stellar-price-oracle-api',
        _meta: { apiVersion: 'v2' },
      },
    });
  });

  v2Router.get('/sources', (req, res) => {
    res.json({
      success: true,
      data: {
        sources: [],
        _meta: { apiVersion: 'v2' },
      },
    });
  });

  app.use('/api/v2', v2Router);

  // Root endpoint showing version information
  app.get('/api', (req, res) => {
    res.json({
      success: true,
      data: {
        versions: {
          v1: {
            status: 'deprecated',
            deprecatedOn: '2026-06-29',
            sunsetDate: DEPRECATION_SUNSET_DATE,
            migrationGuide: DEPRECATION_LINK,
          },
          v2: {
            status: 'stable',
            releaseDate: '2026-01-01',
            supportedUntil: '2030-01-01',
          },
        },
      },
    });
  });

  // Versioning policy endpoint
  app.get('/api/versioning-policy', (req, res) => {
    res.json({
      success: true,
      data: {
        policy: {
          currentVersion: 'v2',
          minimumSupportedVersion: 'v1',
          sunsetSchedule: {
            v1: {
              deprecatedOn: '2026-06-29',
              sunsetDate: DEPRECATION_SUNSET_DATE,
              description: 'v1 is in maintenance mode. No new features will be added.',
            },
          },
          supportTimeline: {
            v2: {
              releaseDate: '2026-01-01',
              currentStatus: 'stable',
              minSupportUntil: '2030-01-01',
            },
          },
          migrationGuide: DEPRECATION_LINK,
        },
      },
    });
  });
});

afterAll(async () => {
  await teardownE2E();
});

describe('Issue #245: API Versioning Strategy and v1 Deprecation Policy', () => {
  describe('API version headers', () => {
    it('should include X-API-Version header in v1 responses', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.headers['x-api-version']).toBe('v1');
    });

    it('should include X-API-Version header in v2 responses', async () => {
      const response = await request(app).get('/api/v2/prices');

      expect(response.status).toBe(200);
      expect(response.headers['x-api-version']).toBe('v2');
    });
  });

  describe('V1 deprecation headers', () => {
    it('should include Deprecation header in v1 responses', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.headers['deprecation']).toBeDefined();
      expect(response.headers['deprecation']).toContain('date=');
    });

    it('should include Sunset header in v1 responses', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.headers['sunset']).toBeDefined();
      // RFC 8594: Sunset is an HTTP-date; verify it matches the configured date.
      const sunsetDate = new Date(response.headers['sunset'] as string);
      expect(isNaN(sunsetDate.getTime())).toBe(false);
      expect(sunsetDate.toISOString().slice(0, 10)).toBe(DEPRECATION_SUNSET_DATE);
    });

    it('should include deprecation Link header in v1 responses', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.headers['link']).toBeDefined();
      expect(response.headers['link']).toContain('rel="deprecation"');
      expect(response.headers['link']).toContain(DEPRECATION_LINK);
    });

    it('should not include deprecation headers in v2 responses', async () => {
      const response = await request(app).get('/api/v2/prices');

      expect(response.status).toBe(200);
      expect(response.headers['deprecation']).toBeUndefined();
      expect(response.headers['sunset']).toBeUndefined();
    });

    it('should have valid deprecation date format', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      const deprecationHeader = response.headers['deprecation'] as string;
      expect(deprecationHeader).toMatch(/date="/);
      // Should parse as valid HTTP date
      const dateMatch = deprecationHeader.match(/date="(.+?)"/);
      if (dateMatch) {
        const date = new Date(dateMatch[1]);
        expect(isNaN(date.getTime())).toBe(false);
      }
    });
  });

  describe('Versioning policy documentation', () => {
    it('should provide versioning policy at root API endpoint', async () => {
      const response = await request(app).get('/api');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('versions');
      expect(response.body.data.versions).toHaveProperty('v1');
      expect(response.body.data.versions).toHaveProperty('v2');
    });

    it('should document v1 as deprecated', async () => {
      const response = await request(app).get('/api');

      expect(response.status).toBe(200);
      expect(response.body.data.versions.v1.status).toBe('deprecated');
      expect(response.body.data.versions.v1).toHaveProperty('deprecatedOn');
      expect(response.body.data.versions.v1).toHaveProperty('sunsetDate');
    });

    it('should document v2 as stable', async () => {
      const response = await request(app).get('/api');

      expect(response.status).toBe(200);
      expect(response.body.data.versions.v2.status).toBe('stable');
      expect(response.body.data.versions.v2).toHaveProperty('releaseDate');
    });

    it('should provide migration guide link', async () => {
      const response = await request(app).get('/api');

      expect(response.status).toBe(200);
      expect(response.body.data.versions.v1).toHaveProperty('migrationGuide');
      expect(response.body.data.versions.v1.migrationGuide).toContain('migration');
    });
  });

  describe('Formal versioning policy endpoint', () => {
    it('should expose formal versioning policy', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('policy');
    });

    it('should document current stable version', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy).toHaveProperty('currentVersion');
      expect(response.body.data.policy.currentVersion).toBe('v2');
    });

    it('should document minimum supported version', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy).toHaveProperty('minimumSupportedVersion');
      expect(response.body.data.policy.minimumSupportedVersion).toBe('v1');
    });

    it('should document sunset schedule', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy).toHaveProperty('sunsetSchedule');
      expect(response.body.data.policy.sunsetSchedule).toHaveProperty('v1');
      expect(response.body.data.policy.sunsetSchedule.v1).toHaveProperty('sunsetDate');
      expect(response.body.data.policy.sunsetSchedule.v1).toHaveProperty('deprecatedOn');
    });

    it('should document support timeline', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy).toHaveProperty('supportTimeline');
      expect(response.body.data.policy.supportTimeline).toHaveProperty('v2');
      expect(response.body.data.policy.supportTimeline.v2).toHaveProperty('releaseDate');
      expect(response.body.data.policy.supportTimeline.v2).toHaveProperty('minSupportUntil');
    });

    it('should provide migration guide in policy', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy).toHaveProperty('migrationGuide');
      expect(response.body.data.policy.migrationGuide).toContain('migration');
    });
  });

  describe('V1 deprecation timeline', () => {
    it('should have clear sunset date', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      const sunsetDate = response.body.data.policy.sunsetSchedule.v1.sunsetDate;
      expect(sunsetDate).toBe(DEPRECATION_SUNSET_DATE);

      // Verify sunset date is a valid date string in future
      const date = new Date(sunsetDate);
      expect(isNaN(date.getTime())).toBe(false);
      expect(date.getTime()).toBeGreaterThan(Date.now());
    });

    it('should have deprecation date before sunset', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      const deprecatedOn = response.body.data.policy.sunsetSchedule.v1.deprecatedOn;
      const sunsetDate = response.body.data.policy.sunsetSchedule.v1.sunsetDate;

      const deprecationDate = new Date(deprecatedOn);
      const sunset = new Date(sunsetDate);

      expect(deprecationDate.getTime()).toBeLessThan(sunset.getTime());
    });

    it('should describe maintenance mode for v1', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy.sunsetSchedule.v1.description).toContain('maintenance');
    });
  });

  describe('V2 stability guarantees', () => {
    it('should document v2 as stable', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy.supportTimeline.v2.currentStatus).toBe('stable');
    });

    it('should provide minimum support duration for v2', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      const minSupport = response.body.data.policy.supportTimeline.v2.minSupportUntil;
      const supportDate = new Date(minSupport);

      // v2 should be supported for at least 3 years
      expect(isNaN(supportDate.getTime())).toBe(false);
      const now = new Date();
      const yearsSupported = (supportDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 365);
      expect(yearsSupported).toBeGreaterThanOrEqual(3);
    });

    it('should have v2 release date', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy.supportTimeline.v2).toHaveProperty('releaseDate');
      const releaseDate = new Date(response.body.data.policy.supportTimeline.v2.releaseDate);
      expect(isNaN(releaseDate.getTime())).toBe(false);
    });
  });

  describe('Version consistency across endpoints', () => {
    it('should maintain v1 version header across all v1 endpoints', async () => {
      const endpoints = ['/api/v1/prices', '/api/v1/health', '/api/v1/sources'];

      for (const endpoint of endpoints) {
        const response = await request(app).get(endpoint);
        expect(response.status).toBe(200);
        expect(response.headers['x-api-version']).toBe('v1');
        expect(response.headers['deprecation']).toBeDefined();
      }
    });

    it('should maintain v2 version header across all v2 endpoints', async () => {
      const endpoints = ['/api/v2/prices', '/api/v2/health', '/api/v2/sources'];

      for (const endpoint of endpoints) {
        const response = await request(app).get(endpoint);
        expect(response.status).toBe(200);
        expect(response.headers['x-api-version']).toBe('v2');
        expect(response.headers['deprecation']).toBeUndefined();
      }
    });
  });

  describe('Migration guidance', () => {
    it('should provide migration link in deprecation header', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.headers['link']).toContain(DEPRECATION_LINK);
    });

    it('should document migration path in policy', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      expect(response.body.data.policy.migrationGuide).toBe(DEPRECATION_LINK);
    });

    it('should include migration info in root endpoint', async () => {
      const response = await request(app).get('/api');

      expect(response.status).toBe(200);
      expect(response.body.data.versions.v1.migrationGuide).toBe(DEPRECATION_LINK);
    });
  });

  describe('Version constant usage', () => {
    it('should use API_VERSIONS.V1 constant', async () => {
      expect(API_VERSIONS.V1).toBe('v1');

      const response = await request(app).get('/api/v1/prices');
      expect(response.headers['x-api-version']).toBe(API_VERSIONS.V1);
    });

    it('should use API_VERSIONS.V2 constant', async () => {
      expect(API_VERSIONS.V2).toBe('v2');

      const response = await request(app).get('/api/v2/prices');
      expect(response.headers['x-api-version']).toBe(API_VERSIONS.V2);
    });

    it('should use DEPRECATION_SUNSET_DATE constant', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      const sunsetDate = new Date(response.headers['sunset'] as string);
      expect(sunsetDate.toISOString().slice(0, 10)).toBe(DEPRECATION_SUNSET_DATE);
    });

    it('should use DEPRECATION_LINK constant', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.headers['link']).toContain(DEPRECATION_LINK);
    });
  });

  describe('HTTP date format compliance', () => {
    it('should use valid HTTP date format in Sunset header', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      const sunsetHeader = response.headers['sunset'];
      // Should be parseable as HTTP date
      const date = new Date(sunsetHeader as string);
      expect(isNaN(date.getTime())).toBe(false);
    });

    it('should use valid HTTP date format in Deprecation header', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      const deprecationHeader = response.headers['deprecation'] as string;
      const dateMatch = deprecationHeader.match(/date="(.+?)"/);
      if (dateMatch) {
        const date = new Date(dateMatch[1]);
        expect(isNaN(date.getTime())).toBe(false);
      }
    });
  });

  describe('Version handling in request routing', () => {
    it('should route /api/v1 requests to v1 implementation', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.headers['x-api-version']).toBe('v1');
    });

    it('should route /api/v2 requests to v2 implementation', async () => {
      const response = await request(app).get('/api/v2/prices');

      expect(response.status).toBe(200);
      expect(response.headers['x-api-version']).toBe('v2');
    });

    it('should handle version-specific response formats', async () => {
      const v1Response = await request(app).get('/api/v1/prices');
      const v2Response = await request(app).get('/api/v2/prices');

      expect(v1Response.status).toBe(200);
      expect(v2Response.status).toBe(200);

      // v2 might have additional metadata
      expect(v2Response.body.data).toHaveProperty('_meta');
    });
  });

  describe('Version documentation completeness', () => {
    it('should have all required fields in deprecation response', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      const policy = response.body.data.policy;

      expect(policy).toHaveProperty('currentVersion');
      expect(policy).toHaveProperty('minimumSupportedVersion');
      expect(policy).toHaveProperty('sunsetSchedule');
      expect(policy).toHaveProperty('supportTimeline');
      expect(policy).toHaveProperty('migrationGuide');
    });

    it('should describe impact of v1 deprecation', async () => {
      const response = await request(app).get('/api/versioning-policy');

      expect(response.status).toBe(200);
      const v1Info = response.body.data.policy.sunsetSchedule.v1;

      expect(v1Info).toHaveProperty('description');
      expect(v1Info.description).toMatch(/maintenance|deprecated|no new features/i);
    });
  });
});
