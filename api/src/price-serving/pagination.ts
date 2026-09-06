export const PAGINATION_DEFAULTS = {
  PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 500,
  OFFSET_PAGE_SIZE: 20,
  MAX_OFFSET_PAGE_SIZE: 100,
} as const;

// ── Cursor helpers (time-series / history) ────────────────────────────────────

export interface CursorPayload {
  ts: number;   // Unix timestamp (seconds) of the last item in the previous page
  dir: 'asc';  // only ascending supported for history
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.ts === 'number' && parsed.dir === 'asc') return parsed as CursorPayload;
    return null;
  } catch {
    return null;
  }
}

// ── Cursor pagination metadata ────────────────────────────────────────────────

export interface CursorPaginationMeta {
  type: 'cursor';
  limit: number;
  count: number;
  hasNextPage: boolean;
  nextCursor: string | null;
}

export function buildCursorMeta<T extends { timestamp: number }>(
  items: T[],
  limit: number,
  timestampField: keyof T = 'timestamp',
): CursorPaginationMeta {
  const hasNextPage = items.length > limit;
  const pageItems = hasNextPage ? items.slice(0, limit) : items;
  const lastItem = pageItems[pageItems.length - 1];
  const nextCursor =
    hasNextPage && lastItem
      ? encodeCursor({ ts: lastItem[timestampField] as number, dir: 'asc' })
      : null;

  return { type: 'cursor', limit, count: pageItems.length, hasNextPage, nextCursor };
}

// ── Offset pagination helpers ─────────────────────────────────────────────────

export interface OffsetPaginationMeta {
  type: 'offset';
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export function applyOffsetPagination<T>(
  items: T[],
  page: number,
  limit: number,
): { items: T[]; meta: OffsetPaginationMeta } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  // Clamp to [1, totalPages]: page 0 (or negative) must behave like page 1 and
  // a page beyond the last page resolves to the final page.
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * limit;
  const paged = items.slice(start, start + limit);

  return {
    items: paged,
    meta: {
      type: 'offset',
      page: safePage,
      limit,
      total,
      totalPages,
      hasNextPage: totalPages > 0 && safePage < totalPages,
      hasPrevPage: totalPages > 0 && safePage > 1,
    },
  };
}
