// Run: node --test tools/contract-call-simulator
import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleSimulator } from './simulator.mjs';

const mk = () => new OracleSimulator({ now: () => 1_000_000, maxAgeSeconds: 300 });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'OK'; };

test('fresh price is returned', () => {
  const s = mk().setFeed('XLM/USD', { price: 123n });
  assert.equal(s.safePrice('XLM/USD').price, 123n);
});
test('boundary: exactly max age is still fresh, one second more is stale', () => {
  const s = mk();
  s.setFeed('A', { ageSeconds: 300 });
  assert.equal(code(() => s.safePrice('A')), 'OK');
  s.setFeed('A', { ageSeconds: 301 });
  assert.equal(code(() => s.safePrice('A')), 'STALE');
});
test('failure states', () => {
  assert.equal(code(() => mk().setFeed('A', { state: 'stale' }).safePrice('A')), 'STALE');
  assert.equal(code(() => mk().setFeed('A', { state: 'missing' }).safePrice('A')), 'MISSING');
  assert.equal(code(() => mk().setFeed('A', { state: 'malformed' }).safePrice('A')), 'MALFORMED');
  assert.equal(code(() => mk().setFeed('A', { state: 'paused' }).safePrice('A')), 'PAUSED');
});
