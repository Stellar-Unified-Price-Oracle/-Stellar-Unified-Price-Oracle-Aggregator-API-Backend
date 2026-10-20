import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedId, toEpochMs, evaluateFreshness, inspectFeed, checkFreshness, checkConnectivity } from './lib.mjs';

const resp = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('normalizeFeedId: normal and invalid', () => {
  assert.equal(normalizeFeedId('xlm-usd'), 'XLM/USD');
  assert.equal(normalizeFeedId(' btc_usd '), 'BTC/USD');
  assert.throws(() => normalizeFeedId('XLM'));
  assert.throws(() => normalizeFeedId('A/B/C'));
  assert.throws(() => normalizeFeedId(42));
});

test('toEpochMs: seconds, ms, ISO, junk', () => {
  assert.equal(toEpochMs(1700000000), 1700000000000);
  assert.equal(toEpochMs(1700000000000), 1700000000000);
  assert.equal(toEpochMs('2024-01-01T00:00:00.000Z'), Date.parse('2024-01-01T00:00:00.000Z'));
  assert.equal(toEpochMs('nope'), null);
  assert.equal(toEpochMs(null), null);
});

test('evaluateFreshness: boundary and unknown', () => {
  const now = 1_000_000_000_000;
  assert.equal(evaluateFreshness(now - 60_000, 60, now).status, 'fresh');
  assert.equal(evaluateFreshness(now - 61_000, 60, now).status, 'stale');
  assert.equal(evaluateFreshness(undefined, 60, now).status, 'unknown');
});

test('inspectFeed: found, not found, server error', async () => {
  const ok = await inspectFeed({ baseUrl: 'http://x', feed: 'xlm-usd', fetchImpl: resp(200, { data: { asset: 'XLM/USD' } }) });
  assert.deepEqual(ok.data, { asset: 'XLM/USD' });
  assert.equal((await inspectFeed({ baseUrl: 'http://x', feed: 'xlm-usd', fetchImpl: resp(404, {}) })).found, false);
  await assert.rejects(() => inspectFeed({ baseUrl: 'http://x', feed: 'xlm-usd', fetchImpl: resp(500, {}) }));
});

test('checkFreshness: missing feed', async () => {
  const r = await checkFreshness({ baseUrl: 'http://x', feed: 'xlm-usd', fetchImpl: resp(404, {}) });
  assert.equal(r.status, 'missing');
});

test('checkConnectivity: failure injected via throwing fetch', async () => {
  const r = await checkConnectivity({ baseUrl: 'http://x', fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].error, 'TimeoutError');
});
