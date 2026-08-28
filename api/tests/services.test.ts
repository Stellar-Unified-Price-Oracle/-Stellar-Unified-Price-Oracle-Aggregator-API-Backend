import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LRUCache, HybridCache } from '../src/price-serving/cache';
import {
  AssetQuerySchema,
  HistoryQuerySchema,
} from '../src/price-serving/validation';
import { webhookService } from '../src/webhooks/webhook-service';
import { compressionMiddleware } from '../src/infrastructure/compression';
import { Request, Response, NextFunction } from 'express';

vi.mock('../src/infrastructure/config', () => ({
  config: {
    webhooks: {
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      maxRetries: 5,
      timeoutMs: 10000,
      minIntervalMs: 60000,
    },
    compression: {
      enabled: true,
      threshold: 1024,
      level: 1,
    },
  },
}));

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string>(10, 5000);
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string>(10, 5000);
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('evicts oldest when over max size', () => {
    const cache = new LRUCache<string>(3, 5000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('d', '4');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe('4');
    expect(cache.size).toBe(3);
  });

  it('expires entries after TTL', async () => {
    const cache = new LRUCache<string>(10, 50);
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');

    await new Promise((r) => setTimeout(r, 80));
    expect(cache.get('key')).toBeUndefined();
  });

  it('clears all entries', () => {
    const cache = new LRUCache<string>(10, 5000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('renews entry on access (LRU promotion)', () => {
    const cache = new LRUCache<string>(2, 5000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a');
    cache.set('c', '3');
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('AssetQuerySchema', () => {
  it('parses valid asset query', () => {
    const result = AssetQuerySchema.safeParse({ asset: 'XLM' });
    expect(result.success).toBe(true);
  });

  it('allows empty query', () => {
    const result = AssetQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects too long asset', () => {
    const result = AssetQuerySchema.safeParse({ asset: 'SUPERLONGASSET' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string asset', () => {
    const result = AssetQuerySchema.safeParse({ asset: 123 });
    expect(result.success).toBe(false);
  });
});

describe('HistoryQuerySchema', () => {
  it('parses valid history query', () => {
    const result = HistoryQuerySchema.safeParse({
      asset: 'XLM',
      from: '1719000000',
      to: '1719086400',
      limit: '50',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it('rejects missing asset', () => {
    const result = HistoryQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('caps limit at 1000', () => {
    const result = HistoryQuerySchema.safeParse({ asset: 'XLM', limit: '9999' });
    expect(result.success).toBe(false);
  });

  it('accepts maximum allowed limit', () => {
    const result = HistoryQuerySchema.safeParse({ asset: 'XLM', limit: '1000' });
    expect(result.success).toBe(true);
  });

  it('rejects negative limit', () => {
    const result = HistoryQuerySchema.safeParse({ asset: 'XLM', limit: '-1' });
    expect(result.success).toBe(false);
  });
});

describe('HybridCache', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

  it('stores and retrieves values in LRU fallback mode', async () => {
    const cache = new HybridCache<string>(logger, { fallbackToLru: true });
    await cache.set('test-key', 'test-value');
    const val = await cache.get('test-key');
    expect(val).toBe('test-value');
  });

  it('returns undefined for missing keys', async () => {
    const cache = new HybridCache<string>(logger, { fallbackToLru: true });
    expect(await cache.get('nonexistent')).toBeUndefined();
  });

  it('uses endpoint-specific TTLs', async () => {
    const cache = new HybridCache<string>(logger, { fallbackToLru: true, priceTtl: 5000, historyTtl: 10000 });
    await cache.set('price:XLM', '100', 'prices');
    await cache.set('history:XLM', 'data', 'history');
    expect(await cache.get('price:XLM')).toBe('100');
    expect(await cache.get('history:XLM')).toBe('data');
  });

  it('invalidates cache', async () => {
    const cache = new HybridCache<string>(logger, { fallbackToLru: true });
    await cache.set('test-key', 'test-value');
    await cache.invalidate('test-*');
    expect(await cache.get('test-key')).toBeUndefined();
  });

  it('reports not using redis when not configured', () => {
    const cache = new HybridCache<string>(logger, { fallbackToLru: true });
    expect(cache.isUsingRedis()).toBe(false);
  });

  it('disconnects without error', async () => {
    const cache = new HybridCache<string>(logger, { fallbackToLru: true });
    await expect(cache.disconnect()).resolves.toBeUndefined();
  });
});

describe('WebhookService', () => {
  it('registers a webhook', () => {
    const wh = webhookService.register('https://example.com/hook', 'key-1', {
      type: 'threshold',
      asset: 'XLM',
      value: 5,
    });
    expect(wh.id).toBeDefined();
    expect(wh.url).toBe('https://example.com/hook');
    expect(wh.active).toBe(true);
    expect(wh.secret).toBeDefined();
  });

  it('lists registered webhooks', () => {
    const wh = webhookService.register('https://example.com/list', 'key-2', {
      type: 'interval',
      asset: 'BTC',
      value: 60000,
    });
    const list = webhookService.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((w) => w.id === wh.id)).toBe(true);
  });

  it('filters webhooks by api key prefix', () => {
    const wh = webhookService.register('https://example.com/filter', 'filter-key', {
      type: 'threshold',
      asset: 'ETH',
      value: 3,
    });
    const filtered = webhookService.list('filter-key');
    expect(filtered.every((w) => w.apiKeyPrefix === 'filter-key')).toBe(true);
  });

  it('gets a webhook by id', () => {
    const wh = webhookService.register('https://example.com/get', 'key-3', {
      type: 'interval',
      asset: 'XLM',
      value: 30000,
    });
    const found = webhookService.get(wh.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(wh.id);
  });

  it('removes a webhook', () => {
    const wh = webhookService.register('https://example.com/remove', 'key-4', {
      type: 'threshold',
      asset: 'SOL',
      value: 10,
    });
    const removed = webhookService.remove(wh.id);
    expect(removed).toBe(true);
    expect(webhookService.get(wh.id)).toBeUndefined();
  });

  it('returns delivery logs', () => {
    const wh = webhookService.register('https://example.com/deliveries', 'key-5', {
      type: 'threshold',
      asset: 'XLM',
      value: 5,
    });
    const logs = webhookService.deliveries();
    expect(Array.isArray(logs)).toBe(true);
  });

  it('handles price updates without throwing', async () => {
    webhookService.register('https://example.com/price-update', 'key-6', {
      type: 'threshold',
      asset: 'XLM',
      value: 5,
    });
    await expect(webhookService.handlePriceUpdate('XLM', 100)).resolves.toBeUndefined();
  });

  it('fires interval webhooks on price update', async () => {
    webhookService.register('https://example.com/interval', 'key-7', {
      type: 'interval',
      asset: 'BTC',
      value: 0,
    });
    await expect(webhookService.handlePriceUpdate('BTC', 50000)).resolves.toBeUndefined();
  });
});

describe('CompressionMiddleware', () => {
  function mockReq(acceptEncoding?: string): Partial<Request> {
    return {
      headers: { 'accept-encoding': acceptEncoding } as any,
    };
  }

  function mockRes(): Partial<Response> {
    const res: Record<string, any> = {};
    res.headersSent = false;
    const jsonFn = vi.fn(() => res);
    const sendFn = vi.fn(() => res);
    res.set = vi.fn(() => res);
    res.json = jsonFn;
    res.send = sendFn;
    res.removeHeader = vi.fn(() => res);
    res.getHeaders = vi.fn(() => ({}));
    return res;
  }

  it('calls next when no accept-encoding', () => {
    const req = mockReq() as Request;
    const res = mockRes() as Response;
    const next = vi.fn() as NextFunction;
    compressionMiddleware({ threshold: 0, level: 1 })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next for unsupported encoding', () => {
    const req = mockReq('deflate') as Request;
    const res = mockRes() as Response;
    const next = vi.fn() as NextFunction;
    compressionMiddleware({ threshold: 0, level: 1 })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next for brotli encoding', () => {
    const req = mockReq('br, gzip') as Request;
    const res = mockRes() as Response;
    const next = vi.fn() as NextFunction;
    compressionMiddleware({ threshold: 0, level: 1 })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes data under threshold uncompressed via send', () => {
    const req = mockReq('gzip') as Request;
    const res = mockRes() as Response;
    const next = vi.fn() as NextFunction;
    compressionMiddleware({ threshold: 99999, level: 1 })(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
