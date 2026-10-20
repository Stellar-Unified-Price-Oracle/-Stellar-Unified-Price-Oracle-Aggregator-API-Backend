// Local fixture server: HTTP (/api/v1/prices[/:asset], /health) and a minimal
// RFC 6455 WebSocket endpoint (/ws) that sends fixture ticks as text frames.
// Failure injection is controlled at runtime via server.inject(mode).
//
// Modes: { type: 'none' }
//        { type: 'status', status: 503, times?: N }   respond with HTTP status
//        { type: 'latency', ms: 200 }                 delay every HTTP response
//        { type: 'malformed' }                        200 with invalid JSON
//        { type: 'drop' }                             destroy the socket (HTTP)
//        { type: 'ws-close' }                         close WS right after handshake
import http from 'node:http';
import crypto from 'node:crypto';
import { prices, wsTicks } from './fixtures.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

export async function startFixtureServer({ port = 0, host = '127.0.0.1' } = {}) {
  let mode = { type: 'none' };
  let remaining = Infinity;
  const requests = [];

  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (mode.type === 'drop') return req.socket.destroy();
    if (mode.type === 'latency') await new Promise((r) => setTimeout(r, mode.ms));
    if (mode.type === 'status' && remaining > 0) {
      remaining -= 1;
      res.writeHead(mode.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'injected', status: mode.status }));
    }
    if (mode.type === 'malformed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"asset": ');
    }
    const url = new URL(req.url, 'http://local');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return json(200, { status: 'ok' });
    if (url.pathname === '/api/v1/prices') return json(200, { data: Object.values(prices) });
    const m = url.pathname.match(/^\/api\/v1\/prices\/(.+)$/);
    if (m) {
      const asset = decodeURIComponent(m[1]);
      return prices[asset] ? json(200, prices[asset]) : json(404, { error: 'unknown asset' });
    }
    return json(404, { error: 'not found' });
  });

  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') return socket.destroy();
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (mode.type === 'ws-close') return socket.end(Buffer.from([0x88, 0x00]));
    for (const tick of wsTicks) socket.write(encodeTextFrame(JSON.stringify(tick)));
  });

  await new Promise((r) => server.listen(port, host, r));
  const { port: boundPort } = server.address();
  return {
    baseUrl: `http://${host}:${boundPort}`,
    wsUrl: `ws://${host}:${boundPort}/ws`,
    requests,
    inject(next) { mode = next; remaining = next.times ?? Infinity; },
    async close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}
