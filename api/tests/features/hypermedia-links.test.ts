import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { setupE2E, teardownE2E } from '../setup';
import { links, withLinks } from '../../src/price-serving/hypermedia';

let app: Express;

beforeAll(async () => {
  await setupE2E();

  app = express();
  app.use(express.json());

  // Root endpoint with HATEOAS links
  app.get('/api/v1', (req, res) => {
    const rootLinks = links.root();
    res.json({
      success: true,
      data: withLinks(
        {
          version: 'v1',
          description: 'Stellar Price Oracle API',
        },
        rootLinks,
      ),
    });
  });

  // Prices list with HATEOAS links
  app.get('/api/v1/prices', (req, res) => {
    const priceLinks = links.prices();
    res.json({
      success: true,
      data: withLinks(
        {
          prices: [
            { asset: 'XLM', price: 0.15 },
            { asset: 'USDC', price: 1.0 },
          ],
        },
        priceLinks,
      ),
    });
  });

  // Individual asset price with HATEOAS links
  app.get('/api/v1/prices/:asset', (req, res) => {
    const { asset } = req.params;
    const assetLinks = links.asset(asset);
    res.json({
      success: true,
      data: withLinks(
        {
          asset: asset.toUpperCase(),
          price: 0.15,
          timestamp: Math.floor(Date.now() / 1000),
        },
        assetLinks,
      ),
    });
  });

  // Price history with HATEOAS links
  app.get('/api/v1/history/:asset', (req, res) => {
    const { asset } = req.params;
    const historyLinks = links.history(asset);
    res.json({
      success: true,
      data: withLinks(
        {
          asset: asset.toUpperCase(),
          history: [
            { timestamp: 1000, price: 0.14 },
            { timestamp: 2000, price: 0.15 },
          ],
        },
        historyLinks,
      ),
    });
  });

  // Health endpoint with HATEOAS links
  app.get('/api/v1/health', (req, res) => {
    const rootLinks = links.root();
    res.json({
      success: true,
      data: withLinks(
        {
          service: 'stellar-price-oracle-api',
          status: 'healthy',
          timestamp: new Date().toISOString(),
        },
        rootLinks,
      ),
    });
  });

  // Sources endpoint with HATEOAS links
  app.get('/api/v1/sources', (req, res) => {
    const sourcesLinks = links.sources();
    res.json({
      success: true,
      data: withLinks(
        {
          sources: [
            { name: 'stellar-quest-api', priority: 1 },
            { name: 'horizon', priority: 2 },
          ],
        },
        sourcesLinks,
      ),
    });
  });

  // Webhook endpoint with HATEOAS links
  app.get('/api/v1/webhooks/:id', (req, res) => {
    const { id } = req.params;
    const webhookLinks = links.webhook(id);
    res.json({
      success: true,
      data: withLinks(
        {
          id,
          url: 'https://example.com/webhook',
          events: ['price.updated'],
          isActive: true,
        },
        webhookLinks,
      ),
    });
  });
});

afterAll(async () => {
  await teardownE2E();
});

describe('Issue #246: Hypermedia/HATEOAS Links on API Responses', () => {
  describe('Root endpoint hypermedia', () => {
    it('should include _links object in root response', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
      expect(typeof response.body.data._links).toBe('object');
    });

    it('should include self link in root response', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('self');
      expect(response.body.data._links.self.href).toBe('/api/v1/');
      expect(response.body.data._links.self.method).toBe('GET');
    });

    it('should include prices link in root response', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('prices');
      expect(response.body.data._links.prices.href).toBe('/api/v1/prices');
      expect(response.body.data._links.prices.method).toBe('GET');
      expect(response.body.data._links.prices.title).toBeTruthy();
    });

    it('should include sources link in root response', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('sources');
      expect(response.body.data._links.sources.href).toBe('/api/v1/sources');
    });

    it('should include health link in root response', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('health');
      expect(response.body.data._links.health.href).toBe('/api/v1/health');
    });

    it('should include docs link in root response', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('docs');
      expect(response.body.data._links.docs.href).toBe('/api/v1/docs');
    });

    it('should include webhook management link in root response', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('webhooks');
      expect(response.body.data._links.webhooks.href).toBe('/api/v1/webhooks');
    });
  });

  describe('Prices endpoint hypermedia', () => {
    it('should include _links in prices list response', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
    });

    it('should include self link for prices endpoint', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('self');
      expect(response.body.data._links.self.href).toBe('/api/v1/prices');
    });

    it('should include sources link in prices response', async () => {
      const response = await request(app).get('/api/v1/prices');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('sources');
    });
  });

  describe('Individual asset price hypermedia', () => {
    it('should include _links in individual asset response', async () => {
      const response = await request(app).get('/api/v1/prices/XLM');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
    });

    it('should include self link for individual asset', async () => {
      const response = await request(app).get('/api/v1/prices/XLM');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('self');
      expect(response.body.data._links.self.href).toBe('/api/v1/prices/XLM');
    });

    it('should include history link for asset', async () => {
      const response = await request(app).get('/api/v1/prices/XLM');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('history');
      expect(response.body.data._links.history.href).toBe('/api/v1/history/XLM');
      expect(response.body.data._links.history.title).toBeTruthy();
    });

    it('should include webhook registration link', async () => {
      const response = await request(app).get('/api/v1/prices/XLM');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('registerWebhook');
      expect(response.body.data._links.registerWebhook.method).toBe('POST');
    });

    it('should normalize asset symbol in links', async () => {
      const response = await request(app).get('/api/v1/prices/xlm');

      expect(response.status).toBe(200);
      expect(response.body.data._links.self.href).toContain('XLM');
    });

    it('should handle contract ID format in links', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5L';
      const response = await request(app).get(`/api/v1/prices/${contractId}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
      expect(response.body.data._links).toHaveProperty('history');
    });
  });

  describe('History endpoint hypermedia', () => {
    it('should include _links in history response', async () => {
      const response = await request(app).get('/api/v1/history/XLM');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
    });

    it('should include self link for history', async () => {
      const response = await request(app).get('/api/v1/history/XLM');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('self');
      expect(response.body.data._links.self.href).toBe('/api/v1/history/XLM');
    });

    it('should include link to current price', async () => {
      const response = await request(app).get('/api/v1/history/XLM');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('price');
      expect(response.body.data._links.price.href).toBe('/api/v1/prices/XLM');
      expect(response.body.data._links.price.title).toBeTruthy();
    });
  });

  describe('Health endpoint hypermedia', () => {
    it('should include _links in health response', async () => {
      const response = await request(app).get('/api/v1/health');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
    });

    it('should include navigation links in health response', async () => {
      const response = await request(app).get('/api/v1/health');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('prices');
      expect(response.body.data._links).toHaveProperty('sources');
    });
  });

  describe('Sources endpoint hypermedia', () => {
    it('should include _links in sources response', async () => {
      const response = await request(app).get('/api/v1/sources');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
    });

    it('should include link back to prices', async () => {
      const response = await request(app).get('/api/v1/sources');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('self');
      expect(response.body.data._links).toHaveProperty('prices');
    });
  });

  describe('Webhook endpoint hypermedia', () => {
    it('should include _links in webhook response', async () => {
      const response = await request(app).get('/api/v1/webhooks/webhook123');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('_links');
    });

    it('should include self link for webhook', async () => {
      const response = await request(app).get('/api/v1/webhooks/webhook123');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('self');
      expect(response.body.data._links.self.href).toContain('webhook123');
    });

    it('should include delete link for webhook', async () => {
      const response = await request(app).get('/api/v1/webhooks/webhook123');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('delete');
      expect(response.body.data._links.delete.method).toBe('DELETE');
    });

    it('should include delivery log link', async () => {
      const response = await request(app).get('/api/v1/webhooks/webhook123');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('deliveries');
      expect(response.body.data._links.deliveries.href).toContain('deliveries');
    });
  });

  describe('Link format and structure', () => {
    it('should include href property on all links', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      Object.entries(response.body.data._links).forEach(([, link]: [string, any]) => {
        expect(link).toHaveProperty('href');
        expect(typeof link.href).toBe('string');
      });
    });

    it('should include method property on action links', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links.self).toHaveProperty('method');
      expect(response.body.data._links.prices).toHaveProperty('method');
    });

    it('should include optional title property on informational links', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links.prices).toHaveProperty('title');
      expect(response.body.data._links.health).toHaveProperty('title');
    });

    it('should use absolute URL paths in href', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      Object.entries(response.body.data._links).forEach(([, link]: [string, any]) => {
        expect(link.href).toMatch(/^\/api/);
      });
    });
  });

  describe('HATEOAS consistency across API versions', () => {
    it('should maintain v1 base path in links', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      Object.entries(response.body.data._links).forEach(([, link]: [string, any]) => {
        expect(link.href).toContain('/api/v1');
      });
    });

    it('should support client navigation through links', async () => {
      // First request to root
      const root = await request(app).get('/api/v1');
      expect(root.status).toBe(200);

      // Follow prices link
      const pricesLink = root.body.data._links.prices.href;
      const prices = await request(app).get(pricesLink);
      expect(prices.status).toBe(200);
      expect(prices.body.data).toHaveProperty('_links');
    });

    it('should enable link-based discovery without hardcoded URLs', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body.data._links).toHaveProperty('prices');
      expect(response.body.data._links).toHaveProperty('health');
      expect(response.body.data._links).toHaveProperty('sources');

      // Client doesn't need to know exact URLs
      expect(response.body.data._links.prices.href).toBeDefined();
      expect(response.body.data._links.health.href).toBeDefined();
    });
  });

  describe('Error responses with hypermedia', () => {
    it('should include _links even in error responses', async () => {
      app.get('/api/v1/test-error', (req, res) => {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND' },
          data: withLinks({}, links.root()),
        });
      });

      const response = await request(app).get('/api/v1/test-error');

      expect(response.status).toBe(404);
      expect(response.body.data).toHaveProperty('_links');
    });
  });
});
