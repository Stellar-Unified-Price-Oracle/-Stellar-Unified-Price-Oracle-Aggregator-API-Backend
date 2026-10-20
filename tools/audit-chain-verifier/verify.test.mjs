import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyChain, canonicalPayload, fingerprint, exportAnchors } from './verify.mjs';

const SECRET = 'test-secret-one';
const KEY = fingerprint(SECRET);

function sign(entry, prev) {
  const hmac = crypto.createHmac('sha256', SECRET).update(canonicalPayload(entry, prev)).digest('hex');
  return { ...entry, prevHmac: prev, hmac };
}

function chain(n, writerId = 'w1') {
  const out = [];
  let prev = '';
  for (let i = 0; i < n; i++) {
    const e = sign({ event: 'KEY_CREATED', timestamp: `2024-01-01T00:00:0${i}Z`, ip: '1.1.1.1', userAgent: 'ua', apiKeyPrefix: 'abc', keyId: KEY, writerId, seq: i + 1 }, prev);
    out.push(e);
    prev = e.hmac;
  }
  return out;
}

test('valid chain passes', () => {
  assert.equal(verifyChain(chain(3), { secrets: [SECRET] }).valid, true);
});

test('tampered field is detected', () => {
  const c = chain(3);
  c[1].ip = '9.9.9.9';
  const r = verifyChain(c, { secrets: [SECRET] });
  assert.equal(r.valid, false);
  assert.equal(r.findings[0].code, 'bad-hmac');
});

test('deleted middle entry is detected', () => {
  const c = chain(3);
  c.splice(1, 1);
  assert.equal(verifyChain(c, { secrets: [SECRET] }).valid, false);
});

test('unknown key is reported', () => {
  const r = verifyChain(chain(1), { secrets: ['other'] });
  assert.equal(r.findings[0].code, 'unknown-key');
});

test('tail truncation is caught by external anchor', () => {
  const c = chain(3);
  const anchors = exportAnchors(c);
  const r = verifyChain(c.slice(0, 2), { secrets: [SECRET], anchors });
  assert.equal(r.valid, false);
  assert.equal(r.findings[0].code, 'anchor-missing');
});

test('empty log is valid', () => {
  assert.equal(verifyChain([], { secrets: [SECRET] }).valid, true);
});
