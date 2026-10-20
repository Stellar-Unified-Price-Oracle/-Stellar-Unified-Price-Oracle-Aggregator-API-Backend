import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkResponseSchema, checkPriceEncoding, checkCursorPagination, checkErrorResponse, checkStreamSemantics } from '../src/checks.mjs';

const spec = JSON.parse(readFileSync(new URL('../../../api/openapi.json', import.meta.url), 'utf8'));
const fx = JSON.parse(readFileSync(new URL('../../../fixtures/generated/api-fixtures.json', import.meta.url), 'utf8')).schemas;

test('shared fixtures pass schema checks', () => {
  for (const name of ['AssetPrice', 'HistoryData', 'CursorPaginationMeta', 'ErrorResponse']) {
    assert.deepEqual(checkResponseSchema(spec, name, fx[name].valid), [], name);
  }
});

test('empty and wrong-type bodies fail', () => {
  assert.ok(checkResponseSchema(spec, 'AssetPrice', fx.AssetPrice.empty_object).length > 0);
  assert.ok(checkResponseSchema(spec, 'AssetPrice', { ...fx.AssetPrice.valid, decimals: '7' }).length > 0);
});

test('price encoding rejects floats', () => {
  assert.deepEqual(checkPriceEncoding(fx.AssetPrice.valid), []);
  assert.ok(checkPriceEncoding({ price: '1.5', decimals: 7 }).length > 0);
});

test('pagination: normal, boundary, failure', () => {
  const page = (cursor, n = 1) => ({ prices: Array(n).fill(fx.HistoryEntry.valid), pagination: { limit: 2, nextCursor: cursor, hasMore: !!cursor } });
  assert.deepEqual(checkCursorPagination([page('a'), page(null)], 2), []);
  assert.deepEqual(checkCursorPagination([page(null, 0)], 2), []);
  assert.ok(checkCursorPagination([page('a'), page('a'), page(null)], 2).length > 0);
  assert.ok(checkCursorPagination([page(null, 3)], 2).length > 0);
  assert.ok(checkCursorPagination([{ prices: [], pagination: { limit: 2, nextCursor: null, hasMore: true } }], 2).length > 0);
});

test('error contract', () => {
  assert.deepEqual(checkErrorResponse(spec, 404, fx.ErrorResponse.valid), []);
  assert.ok(checkErrorResponse(spec, 200, fx.ErrorResponse.valid).length > 0);
  assert.ok(checkErrorResponse(spec, 400, { code: 'bad', message: 'x' }).length > 0);
});

test('stream timestamps must not regress', () => {
  const a = fx.AssetPrice.valid;
  assert.deepEqual(checkStreamSemantics(spec, [a, { ...a, timestamp: a.timestamp + 1 }]), []);
  assert.ok(checkStreamSemantics(spec, [a, { ...a, timestamp: a.timestamp - 1 }]).length > 0);
});
