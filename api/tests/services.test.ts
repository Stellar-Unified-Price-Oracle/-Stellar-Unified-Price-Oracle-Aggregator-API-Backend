import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LRUCache } from '../src/services/cache';
import {
  AssetQuerySchema,
  HistoryQuerySchema,
} from '../src/services/validation';

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
});
