import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || '';
const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

const latencies = {
  prices: new Trend('latency_prices', true),
  priceAsset: new Trend('latency_price_asset', true),
  history: new Trend('latency_history', true),
  health: new Trend('latency_health', true),
};

export const options = {
  vus: 10,
  duration: '1m',
  thresholds: {
    latency_prices: ['p(95)<400'],
    latency_price_asset: ['p(95)<300'],
    latency_history: ['p(95)<600'],
    latency_health: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

const ASSETS = ['XLM', 'BTC', 'ETH', 'USDC', 'USDT'];

export default function () {
  group('GET /prices', () => {
    const res = http.get(`${BASE_URL}/api/v1/prices`, { headers });
    latencies.prices.add(res.timings.duration);
    check(res, { 'prices 200': (r) => r.status === 200 });
  });

  group('GET /prices/:asset', () => {
    const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
    const res = http.get(`${BASE_URL}/api/v1/prices/${asset}`, { headers });
    latencies.priceAsset.add(res.timings.duration);
    check(res, { 'price asset 200 or 404': (r) => r.status === 200 || r.status === 404 });
  });

  group('GET /history/:asset', () => {
    const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
    const res = http.get(`${BASE_URL}/api/v1/history/${asset}?limit=10`, { headers });
    latencies.history.add(res.timings.duration);
    check(res, { 'history 200': (r) => r.status === 200 });
  });

  group('GET /health', () => {
    const res = http.get(`${BASE_URL}/api/v1/health`);
    latencies.health.add(res.timings.duration);
    check(res, { 'health 200 or 503': (r) => r.status === 200 || r.status === 503 });
  });

  sleep(0.5);
}
