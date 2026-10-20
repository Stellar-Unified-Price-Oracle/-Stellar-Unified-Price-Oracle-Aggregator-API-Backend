import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { createClient, verifyPrice, OracleError } from '../src/client.mjs';

const fx = JSON.parse(readFileSync(new URL('../../../../fixtures/generated/api-fixtures.json', import.meta.url), 'utf8')).schemas;
const cfg = { baseUrl: 'https://o.test', apiKey: null, timeoutMs: 1000, maxRetries: 2, maxPriceAgeSec: 60 };
const resp = (status, body, headers = {}) => ({ ok: status < 400, status, statusText: 'x', json: async () => body, headers: { get: (k) => headers[k] } });
const noSleep = async () => {};

test('config: requires https and bounds', () => {
  assert.throws(() => loadConfig({}), /required/);
  assert.throws(() => loadConfig({ ORACLE_BASE_URL: 'http://evil.example' }), /https/);
  assert.throws(() => loadConfig({ ORACLE_BASE_URL: 'https://o.test', ORACLE_MAX_RETRIES: '99' }), /between/);
  assert.equal(loadConfig({ ORACLE_BASE_URL: 'https://o.test' }).timeoutMs, 5000);
});

test('verifyPrice: normal, stale, zero, float', () => {
  const p = fx.AssetPrice.valid;
  assert.equal(verifyPrice(p, { now: p.timestamp + 5 }).value, 10000000000n);
  assert.throws(() => verifyPrice(p, { now: p.timestamp + 500 }), { code: 'STALE_PRICE' });
  assert.throws(() => verifyPrice({ ...p, price: '0' }, { now: p.timestamp }), { code: 'ZERO_PRICE' });
  assert.throws(() => verifyPrice({ ...p, price: '1.5' }), { code: 'BAD_PRICE_ENCODING' });
});

test('client: 404 is not retried and maps error code', async () => {
  let calls = 0;
  const c = createClient(cfg, async () => { calls++; return resp(404, fx.ErrorResponse.valid); }, noSleep);
  await assert.rejects(c.getPrice('NOPE'), (e) => e instanceof OracleError && e.code === 'NOT_FOUND' && e.status === 404);
  assert.equal(calls, 1);
});

test('client: retries 503 then succeeds; gives up after maxRetries', async () => {
  let n = 0;
  const ok = createClient(cfg, async () => (++n < 3 ? resp(503, {}) : resp(200, { ...fx.AssetPrice.valid, timestamp: Date.now() / 1000 })), noSleep);
  assert.equal((await ok.getPrice('XLM')).decimals, 7);
  n = 0;
  const bad = createClient(cfg, async () => { n++; return resp(503, {}); }, noSleep);
  await assert.rejects(bad.getPrice('XLM'), { status: 503 });
  assert.equal(n, 3);
});
