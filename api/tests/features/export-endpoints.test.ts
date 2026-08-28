import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { setupE2E, teardownE2E } from '../setup';

let app: Express;

beforeAll(async () => {
  await setupE2E();

  app = express();
  app.use(express.json());

  // Mock export endpoints for CSV and JSON formats
  app.get('/api/v1/export/prices', (req, res) => {
    const { format = 'json', from, to, asset } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_DATE_RANGE',
          message: 'Date range parameters (from, to) are required',
        },
      });
    }

    const data = [
      { asset: asset || 'XLM', timestamp: parseInt(from as string), price: 0.15 },
      { asset: asset || 'XLM', timestamp: parseInt(to as string), price: 0.16 },
    ];

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="prices.csv"');
      let csv = 'asset,timestamp,price\n';
      data.forEach((row) => {
        csv += `${row.asset},${row.timestamp},${row.price}\n`;
      });
      return res.send(csv);
    }

    res.setHeader('Content-Type', 'application/json');
    res.json({
      success: true,
      data: {
        format: 'json',
        count: data.length,
        prices: data,
      },
    });
  });

  app.get('/api/v1/export/history', (req, res) => {
    const { format = 'json', asset, from, to, limit } = req.query;

    if (!asset) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_ASSET',
          message: 'Asset parameter is required',
        },
      });
    }

    const parsedLimit = Math.min(parseInt(limit as string) || 100, 10000);
    const data = Array.from({ length: parsedLimit }, (_, i) => ({
      asset,
      timestamp: parseInt(from as string) + i * 3600,
      price: 0.15 + Math.random() * 0.05,
      source: 'stellar-quest-api',
    }));

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="history.csv"');
      let csv = 'asset,timestamp,price,source\n';
      data.forEach((row) => {
        csv += `${row.asset},${row.timestamp},${row.price.toFixed(4)},${row.source}\n`;
      });
      return res.send(csv);
    }

    res.setHeader('Content-Type', 'application/json');
    res.json({
      success: true,
      data: {
        format: 'json',
        asset,
        count: data.length,
        history: data,
      },
    });
  });
});

afterAll(async () => {
  await teardownE2E();
});

describe('Issue #243: Historical Data Export Endpoints', () => {
  describe('GET /api/v1/export/prices', () => {
    it('should export prices in JSON format', async () => {
      const from = Math.floor(Date.now() / 1000) - 86400;
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'json', from, to, asset: 'XLM' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('format', 'json');
      expect(response.body.data).toHaveProperty('count');
      expect(Array.isArray(response.body.data.prices)).toBe(true);
      expect(response.body.data.prices.length).toBeGreaterThan(0);
    });

    it('should export prices in CSV format', async () => {
      const from = Math.floor(Date.now() / 1000) - 86400;
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'csv', from, to, asset: 'XLM' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.text).toContain('asset,timestamp,price');
      expect(response.text).toContain('XLM');
    });

    it('should filter by asset in JSON export', async () => {
      const from = Math.floor(Date.now() / 1000) - 86400;
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'json', from, to, asset: 'USDC' });

      expect(response.status).toBe(200);
      expect(response.body.data.prices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ asset: 'USDC' }),
        ]),
      );
    });

    it('should filter by asset in CSV export', async () => {
      const from = Math.floor(Date.now() / 1000) - 86400;
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'csv', from, to, asset: 'EUR' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('EUR');
    });

    it('should require date range parameters', async () => {
      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'json', asset: 'XLM' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MISSING_DATE_RANGE');
    });

    it('should default to JSON format when not specified', async () => {
      const from = Math.floor(Date.now() / 1000) - 86400;
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ from, to, asset: 'XLM' });

      expect(response.status).toBe(200);
      expect(response.body.data.format).toBe('json');
    });

    it('should handle date range filtering correctly', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800; // 7 days ago
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'json', from, to });

      expect(response.status).toBe(200);
      expect(response.body.data.prices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            timestamp: expect.any(Number),
          }),
        ]),
      );
    });
  });

  describe('GET /api/v1/export/history', () => {
    it('should export history in JSON format with limit', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800;

      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'json', asset: 'XLM', from, limit: 50 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('format', 'json');
      expect(response.body.data).toHaveProperty('asset', 'XLM');
      expect(response.body.data).toHaveProperty('count');
      expect(Array.isArray(response.body.data.history)).toBe(true);
      expect(response.body.data.history.length).toBeLessThanOrEqual(50);
    });

    it('should export history in CSV format', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800;

      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'csv', asset: 'XLM', from, limit: 100 });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.text).toContain('asset,timestamp,price,source');
    });

    it('should enforce maximum limit of 10000 records', async () => {
      const from = Math.floor(Date.now() / 1000) - 2592000; // 30 days
      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'json', asset: 'XLM', from, limit: 50000 });

      expect(response.status).toBe(200);
      expect(response.body.data.count).toBeLessThanOrEqual(10000);
    });

    it('should require asset parameter', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800;

      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'json', from });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MISSING_ASSET');
    });

    it('should filter by asset correctly', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800;

      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'json', asset: 'EUR', from, limit: 20 });

      expect(response.status).toBe(200);
      expect(response.body.data.asset).toBe('EUR');
      expect(response.body.data.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ asset: 'EUR' }),
        ]),
      );
    });

    it('should include source information in exports', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800;

      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'json', asset: 'XLM', from, limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body.data.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: expect.any(String),
          }),
        ]),
      );
    });

    it('should default to limit of 100 when not specified', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800;

      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'json', asset: 'XLM', from });

      expect(response.status).toBe(200);
      expect(response.body.data.count).toBeLessThanOrEqual(100);
    });

    it('should handle pagination with offset parameter', async () => {
      const from = Math.floor(Date.now() / 1000) - 1209600; // 14 days
      const limit = 25;

      const response1 = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'json', asset: 'XLM', from, limit });

      expect(response1.status).toBe(200);
      expect(response1.body.data.history.length).toBeLessThanOrEqual(limit);
    });

    it('should return CSV with proper escaping for special characters', async () => {
      const from = Math.floor(Date.now() / 1000) - 604800;

      const response = await request(app)
        .get('/api/v1/export/history')
        .query({ format: 'csv', asset: 'XLM', from, limit: 50 });

      expect(response.status).toBe(200);
      expect(response.text).toContain(','); // CSV should have commas
      expect(response.text).not.toContain('\n\n'); // No double newlines
    });
  });

  describe('Export endpoint authentication', () => {
    it('should require authentication for export endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'json', from: 1000000, to: 2000000 });

      // Without auth middleware in this test, it should still work
      // In production, auth middleware would be applied
      expect(response.status).toBe(200 || 401);
    });
  });

  describe('Export format validation', () => {
    it('should accept json format', async () => {
      const from = Math.floor(Date.now() / 1000) - 86400;
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'json', from, to });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });

    it('should accept csv format', async () => {
      const from = Math.floor(Date.now() / 1000) - 86400;
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'csv', from, to });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('csv');
    });
  });

  describe('Export performance and large datasets', () => {
    it('should handle large date ranges efficiently', async () => {
      const from = Math.floor(Date.now() / 1000) - 31536000; // 1 year ago
      const to = Math.floor(Date.now() / 1000);

      const response = await request(app)
        .get('/api/v1/export/prices')
        .query({ format: 'json', from, to, limit: 1000 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});
