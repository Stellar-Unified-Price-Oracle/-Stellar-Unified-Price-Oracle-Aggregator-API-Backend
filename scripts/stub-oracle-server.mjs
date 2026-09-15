#!/usr/bin/env node
// Local stand-in for the four upstream oracle APIs.
//
// Integration tests need the aggregator to produce real prices, but pointing it
// at the live providers would make CI depend on four third-party services. This
// stub serves the exact response shape each source module parses, from one
// deterministic price table, so the pipeline can run end to end offline.
//
// Every source is pointed at this one base URL, so routes are distinguished by
// path: /price (chainlink), /prices (redstone), /oracle/v1/feeds/:s (band),
// /v1/prices (reflector).
//
// Note the deliberate decimal spread (8 vs 9 vs 18) — the aggregator has to
// reduce mixed-scale sources to a common scale, and this keeps that path
// exercised in CI rather than only in unit tests.

import http from 'node:http';

const PORT = parseInt(process.env.STUB_ORACLE_PORT || '4010', 10);

// Underlying decimal price per asset, shared by every provider.
const PRICES = {
  XLM: 0.12,
  USDC: 1.0,
  BTC: 65000.0,
  ETH: 3500.0,
  USDT: 1.0,
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function priceFor(symbol) {
  const key = String(symbol || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(PRICES, key) ? PRICES[key] : null;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const log = (label) => console.log(`[stub-oracle] ${label} ${req.url}`);

  // Chainlink — { USD: { PRICE: <decimal> } }, scaled by the source at 8 dp.
  if (path === '/price') {
    const price = priceFor(url.searchParams.get('fsym'));
    if (price === null) return send(res, 200, {});
    log('chainlink');
    return send(res, 200, { USD: { PRICE: price } });
  }

  // Redstone — { <SYMBOL>: { value, decimals } }.
  if (path === '/prices') {
    const symbol = String(url.searchParams.get('symbols') || '').toUpperCase();
    const price = priceFor(symbol);
    if (price === null) return send(res, 200, {});
    log('redstone');
    return send(res, 200, { [symbol]: { value: String(price), decimals: 8 } });
  }

  // Band — { data: { price, decimals, updated_at } }. Symbols arrive as
  // "<BASE>-USD"; updated_at is the provider's own observation time.
  if (path.startsWith('/oracle/v1/feeds/')) {
    const raw = decodeURIComponent(path.slice('/oracle/v1/feeds/'.length));
    const price = priceFor(raw.replace(/-USD$/i, ''));
    if (price === null) return send(res, 404, { error: 'unknown feed' });
    log('band');
    return send(res, 200, {
      data: { price: String(price), decimals: 9, updated_at: nowSeconds() },
    });
  }

  // Reflector — { prices: { "Crypto.<BASE>/USD": { price, decimals, timestamp } } }.
  if (path === '/v1/prices') {
    const asset = String(url.searchParams.get('asset') || '');
    const base = asset.replace(/^Crypto\./i, '').replace(/\/USD$/i, '');
    const price = priceFor(base);
    if (price === null) return send(res, 200, { prices: {} });
    log('reflector');
    return send(res, 200, {
      prices: {
        [asset]: { price: String(price), decimals: 8, timestamp: nowSeconds() },
      },
    });
  }

  send(res, 404, { error: `no stub route for ${path}` });
});

server.listen(PORT, () => {
  console.log(`[stub-oracle] listening on http://localhost:${PORT}`);
  console.log(`[stub-oracle] assets: ${Object.keys(PRICES).join(', ')}`);
});
