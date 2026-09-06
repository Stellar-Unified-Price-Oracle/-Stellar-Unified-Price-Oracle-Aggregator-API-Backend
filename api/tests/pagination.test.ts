/**
 * #296 — Unit tests for the pagination helpers:
 * cursor-based (`encodeCursor`, `decodeCursor`, `buildCursorMeta`) and
 * offset-based (`applyOffsetPagination`), covering boundary conditions,
 * empty datasets, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  PAGINATION_DEFAULTS,
  encodeCursor,
  decodeCursor,
  buildCursorMeta,
  applyOffsetPagination,
} from '../src/price-serving/pagination';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a valid cursor payload', () => {
    const payload = { ts: 1_717_901_000, dir: 'asc' as const };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('returns null for a non-base64 string', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for invalid JSON inside the cursor', () => {
    const bogus = Buffer.from('not-json').toString('base64url');
    expect(decodeCursor(bogus)).toBeNull();
  });

  it('returns null when the decoded payload is missing ts or has the wrong dir', () => {
    expect(decodeCursor(Buffer.from(JSON.stringify({ dir: 'asc' })).toString('base64url'))).toBeNull();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ ts: 'x', dir: 'asc' })).toString('base64url')),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ ts: 1, dir: 'desc' })).toString('base64url')),
    ).toBeNull();
  });

  it('is deterministic for identical payloads', () => {
    expect(encodeCursor({ ts: 5, dir: 'asc' })).toBe(encodeCursor({ ts: 5, dir: 'asc' }));
  });
});

describe('buildCursorMeta (cursor pagination)', () => {
  it('marks hasNextPage true and returns a nextCursor when the page is exactly full', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ timestamp: 100 + i }));
    const meta = buildCursorMeta(items, 5, 'timestamp');
    expect(meta).toEqual({
      type: 'cursor',
      limit: 5,
      count: 5,
      hasNextPage: true,
      nextCursor: expect.stringContaining('') as unknown,
    });
    expect(meta.hasNextPage).toBe(true);
    expect(meta.nextCursor).not.toBeNull();
    // The encoded cursor encodes the last item's timestamp.
    expect(decodeCursor(meta.nextCursor as string)?.ts).toBe(104);
  });

  it('returns hasNextPage false and null nextCursor for a short final page', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ timestamp: 10 + i }));
    const meta = buildCursorMeta(items, 5, 'timestamp');
    expect(meta.hasNextPage).toBe(false);
    expect(meta.nextCursor).toBeNull();
  });

  it('handles an empty dataset', () => {
    const meta = buildCursorMeta([], 5, 'timestamp');
    expect(meta.count).toBe(0);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.nextCursor).toBeNull();
  });

  it('honours a custom timestamp field name', () => {
    const items = [{ seq: 42 }];
    const meta = buildCursorMeta(items, 1, 'seq');
    expect(meta.hasNextPage).toBe(true); // page full
    expect(decodeCursor(meta.nextCursor as string)?.ts).toBe(42);
  });
});

describe('applyOffsetPagination (offset pagination)', () => {
  const dataset = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));

  it('returns the requested page slice and metadata', () => {
    const { items, meta } = applyOffsetPagination(dataset, 2, 10);
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({ id: 11 });
    expect(meta).toMatchObject({
      type: 'offset',
      page: 2,
      limit: 10,
      total: 25,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });

  it('returns an empty items array for an empty dataset', () => {
    const { items, meta } = applyOffsetPagination([], 1, 10);
    expect(items).toEqual([]);
    expect(meta.total).toBe(0);
    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPrevPage).toBe(false);
    expect(meta.page).toBe(1);
  });

  it('clamps page 0 to page 1 and does not paginate backward', () => {
    const { items, meta } = applyOffsetPagination(dataset, 0, 10);
    expect(meta.page).toBe(1);
    expect(items[0]).toEqual({ id: 1 });
    expect(meta.hasPrevPage).toBe(false);
  });

  it('clamps a page beyond the last page to the final page', () => {
    const { items, meta } = applyOffsetPagination(dataset, 99, 10);
    expect(meta.page).toBe(3);
    expect(items[0]).toEqual({ id: 21 });
    expect(meta.hasNextPage).toBe(false);
  });

  it('handles an exact full final page', () => {
    const even = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
    const { items, meta } = applyOffsetPagination(even, 2, 10);
    expect(items).toHaveLength(10);
    expect(meta.page).toBe(2);
    expect(meta.totalPages).toBe(2);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPrevPage).toBe(true);
  });

  it('does not mutate the source array', () => {
    const source = [...dataset];
    applyOffsetPagination(source, 1, 10);
    expect(source).toHaveLength(25);
  });

  it('exposes sane default limits in PAGINATION_DEFAULTS', () => {
    expect(PAGINATION_DEFAULTS.PAGE_SIZE).toBe(50);
    expect(PAGINATION_DEFAULTS.MAX_PAGE_SIZE).toBe(500);
    expect(PAGINATION_DEFAULTS.OFFSET_PAGE_SIZE).toBe(20);
    expect(PAGINATION_DEFAULTS.MAX_OFFSET_PAGE_SIZE).toBe(100);
  });
});