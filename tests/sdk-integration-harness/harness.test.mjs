import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFixtureServer } from './fixture-server.mjs';
import { prices } from './fixtures.mjs';

test('normal: returns deterministic price fixtures', async () => {
  const s = await startFixtureServer();
  try {
    const r = await fetch(`${s.baseUrl}/api/v1/prices/${encodeURIComponent('XLM/USD')}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), prices['XLM/USD']);
    const list = await (await fetch(`${s.baseUrl}/api/v1/prices`)).json();
    assert.equal(list.data.length, 2);
  } finally { await s.close(); }
});

test('boundary: unknown asset yields 404', async () => {
  const s = await startFixtureServer();
  try {
    const r = await fetch(`${s.baseUrl}/api/v1/prices/NOPE%2FUSD`);
    assert.equal(r.status, 404);
  } finally { await s.close(); }
});

test('failure injection: status with limited count then recovery', async () => {
  const s = await startFixtureServer();
  try {
    s.inject({ type: 'status', status: 503, times: 2 });
    assert.equal((await fetch(`${s.baseUrl}/health`)).status, 503);
    assert.equal((await fetch(`${s.baseUrl}/health`)).status, 503);
    assert.equal((await fetch(`${s.baseUrl}/health`)).status, 200);
  } finally { await s.close(); }
});

test('failure injection: malformed JSON, dropped connection, latency', async () => {
  const s = await startFixtureServer();
  try {
    s.inject({ type: 'malformed' });
    const r = await fetch(`${s.baseUrl}/api/v1/prices`);
    await assert.rejects(() => r.json());
    s.inject({ type: 'drop' });
    await assert.rejects(() => fetch(`${s.baseUrl}/health`));
    s.inject({ type: 'latency', ms: 150 });
    const t0 = Date.now();
    await fetch(`${s.baseUrl}/health`);
    assert.ok(Date.now() - t0 >= 140);
  } finally { await s.close(); }
});

function wsConnect(port, onData) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('data', onData);
    sock.on('close', resolve);
    setTimeout(() => sock.destroy(), 300);
  });
}

test('websocket: handshake and fixture ticks delivered', async () => {
  const s = await startFixtureServer();
  try {
    let buf = '';
    await wsConnect(new URL(s.baseUrl).port, (d) => { buf += d.toString('latin1'); });
    assert.match(buf, /101 Switching Protocols/);
    assert.match(buf, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.match(buf, /XLM\/USD/);
  } finally { await s.close(); }
});

test('websocket failure injection: server closes right after handshake', async () => {
  const s = await startFixtureServer();
  try {
    s.inject({ type: 'ws-close' });
    let buf = '';
    await wsConnect(new URL(s.baseUrl).port, (d) => { buf += d.toString('latin1'); });
    assert.match(buf, /101 Switching Protocols/);
    assert.doesNotMatch(buf, /XLM\/USD/);
  } finally { await s.close(); }
});
