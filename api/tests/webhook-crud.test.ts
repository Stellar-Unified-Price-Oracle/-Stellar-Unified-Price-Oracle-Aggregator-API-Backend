import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { webhookService, WebhookRegistration, WebhookTrigger } from '../src/webhooks/webhook-service';

describe('Webhooks: CRUD Management and Delivery System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webhookService.reset();
  });

  describe('POST /webhooks - Register webhook', () => {
    it('should register a new webhook with threshold trigger', () => {
      const url = 'https://webhook.example.com/price-change';
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };

      const webhook = webhookService.register(url, 'test-key-prefix', trigger);

      expect(webhook).toBeDefined();
      expect(webhook.url).toBe(url);
      expect(webhook.trigger).toEqual(trigger);
      expect(webhook.active).toBe(true);
      expect(webhook.id).toBeDefined();
      expect(webhook.secret).toBeDefined();
      expect(webhook.createdAt).toBeDefined();
    });

    it('should register a webhook with interval trigger', () => {
      const url = 'https://webhook.example.com/price-update';
      const trigger: WebhookTrigger = { type: 'interval', asset: 'XLM', value: 60000 };

      const webhook = webhookService.register(url, 'test-key-prefix', trigger);

      expect(webhook.trigger.type).toBe('interval');
      expect(webhook.trigger.value).toBe(60000);
    });

    it('should generate unique IDs for each webhook', () => {
      const url1 = 'https://webhook1.example.com';
      const url2 = 'https://webhook2.example.com';
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };

      const webhook1 = webhookService.register(url1, 'key1', trigger);
      const webhook2 = webhookService.register(url2, 'key2', trigger);

      expect(webhook1.id).not.toBe(webhook2.id);
    });

    it('should generate unique secrets for each webhook', () => {
      const url = 'https://webhook.example.com';
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };

      const webhook1 = webhookService.register(url, 'key1', trigger);
      const webhook2 = webhookService.register(url, 'key2', trigger);

      expect(webhook1.secret).not.toBe(webhook2.secret);
    });
  });

  describe('GET /webhooks - List webhooks', () => {
    it('should return empty list when no webhooks exist', () => {
      const webhooks = webhookService.list();
      expect(webhooks).toEqual([]);
    });

    it('should list all registered webhooks', () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      webhookService.register('https://webhook1.example.com', 'key1', trigger);
      webhookService.register('https://webhook2.example.com', 'key2', trigger);
      webhookService.register('https://webhook3.example.com', 'key3', trigger);

      const webhooks = webhookService.list();
      expect(webhooks.length).toBe(3);
    });

    it('should filter webhooks by API key prefix', () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      webhookService.register('https://webhook1.example.com', 'key1', trigger);
      webhookService.register('https://webhook2.example.com', 'key1', trigger);
      webhookService.register('https://webhook3.example.com', 'key2', trigger);

      const key1Webhooks = webhookService.list('key1');
      expect(key1Webhooks.length).toBe(2);
      expect(key1Webhooks.every((w) => w.apiKeyPrefix === 'key1')).toBe(true);

      const key2Webhooks = webhookService.list('key2');
      expect(key2Webhooks.length).toBe(1);
    });

    it('should return complete webhook details', () => {
      const url = 'https://webhook.example.com';
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const registered = webhookService.register(url, 'test-key', trigger);

      const webhooks = webhookService.list();
      const found = webhooks[0];

      expect(found.id).toBe(registered.id);
      expect(found.url).toBe(url);
      expect(found.apiKeyPrefix).toBe('test-key');
      expect(found.trigger).toEqual(trigger);
      expect(found.active).toBe(true);
    });
  });

  describe('GET /webhooks/{id} - Get webhook details', () => {
    it('should retrieve a webhook by ID', () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const registered = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      const retrieved = webhookService.get(registered.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(registered.id);
      expect(retrieved?.url).toBe('https://webhook.example.com');
    });

    it('should return undefined for non-existent webhook', () => {
      const webhook = webhookService.get('non-existent-id');
      expect(webhook).toBeUndefined();
    });
  });

  describe('DELETE /webhooks/{id} - Remove webhook', () => {
    it('should delete a registered webhook', () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      const result = webhookService.remove(webhook.id);
      expect(result).toBe(true);

      const retrieved = webhookService.get(webhook.id);
      expect(retrieved).toBeUndefined();
    });

    it('should return false when deleting non-existent webhook', () => {
      const result = webhookService.remove('non-existent-id');
      expect(result).toBe(false);
    });

    it('should remove webhook from list', () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook1 = webhookService.register('https://webhook1.example.com', 'key1', trigger);
      const webhook2 = webhookService.register('https://webhook2.example.com', 'key1', trigger);

      webhookService.remove(webhook1.id);

      const remaining = webhookService.list('key1');
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(webhook2.id);
    });
  });

  describe('Webhook Delivery with Exponential Backoff', () => {
    it('should log successful delivery', async () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      ));

      await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5, timestamp: 1234567890 });

      const deliveries = webhookService.deliveries(webhook.id);
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries[0].success).toBe(true);
      expect(deliveries[0].statusCode).toBe(200);
    });

    it('should retry failed deliveries', async () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      let attemptCount = 0;
      vi.stubGlobal('fetch', vi.fn(() => {
        attemptCount++;
        if (attemptCount < 2) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }));

      await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5, timestamp: 1234567890 });

      const deliveries = webhookService.deliveries(webhook.id);
      expect(deliveries.length).toBeGreaterThanOrEqual(1);
    });

    it('should log delivery attempts', async () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      ));

      await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5, timestamp: 1234567890 });

      const deliveries = webhookService.deliveries(webhook.id);
      expect(deliveries[0]).toHaveProperty('attempt');
      expect(deliveries[0]).toHaveProperty('success');
      expect(deliveries[0]).toHaveProperty('timestamp');
    });
  });

  describe('GET /webhooks/{id}/deliveries - Delivery History', () => {
    it('should retrieve delivery logs for a webhook', async () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      ));

      await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5, timestamp: 1234567890 });

      const deliveries = webhookService.deliveries(webhook.id);
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries[0].webhookId).toBe(webhook.id);
    });

    it('should return empty array when no deliveries exist', () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      const deliveries = webhookService.deliveries(webhook.id);
      expect(deliveries).toEqual([]);
    });

    it('should include delivery error messages on failure', async () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      const errorMessage = 'Connection refused';
      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.reject(new Error(errorMessage))
      ));

      await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5, timestamp: 1234567890 });

      const deliveries = webhookService.deliveries(webhook.id);
      const failedDelivery = deliveries.find((d) => d.error);
      expect(failedDelivery).toBeDefined();
      expect(failedDelivery?.error).toBeDefined();
    });
  });

  describe('Price Update Triggers', () => {
    it('should fire threshold-triggered webhooks on price change', async () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      ));

      await webhookService.handlePriceUpdate('XLM', 0.5);
      await webhookService.handlePriceUpdate('XLM', 0.53);

      const deliveries = webhookService.deliveries();
      expect(deliveries.length).toBeGreaterThan(0);
    });

    it('should fire interval-triggered webhooks at specified intervals', async () => {
      const trigger: WebhookTrigger = { type: 'interval', asset: 'XLM', value: 1000 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      ));

      await webhookService.handlePriceUpdate('XLM', 0.5);

      const deliveries = webhookService.deliveries(webhook.id);
      expect(deliveries.length).toBeGreaterThan(0);
    });

    it('should not fire inactive webhooks', async () => {
      const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };
      const webhook = webhookService.register('https://webhook.example.com', 'test-key', trigger);

      vi.stubGlobal('fetch', vi.fn());

      webhook.active = false;
      await webhookService.handlePriceUpdate('XLM', 0.5);
      await webhookService.handlePriceUpdate('XLM', 0.53);

      const deliveries = webhookService.deliveries(webhook.id);
      expect(deliveries).toEqual([]);
    });
  });
});
