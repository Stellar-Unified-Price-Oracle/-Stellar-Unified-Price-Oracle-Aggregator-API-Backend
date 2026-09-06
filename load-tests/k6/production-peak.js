import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || '';
const PEAK_RPS = Number(__ENV.PEAK_RPS || 50);
const DURATION = __ENV.DURATION || '5m';
const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

const latencies = {
  prices: new Trend('latency_prices', true),
  history: new Trend('latency_history', true),
};

const ASSETS = ['XLM', 'BTC', 'ETH', 'USDC', 'USDT'];

export const options = {
  scenarios: {
    peak_rps: {
      executor: 'constant-arrival-rate',
      rate: PEAK_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(20, PEAK_RPS),
      maxVUs: Math.max(60, PEAK_RPS * 4),
      gracefulStop: '30s',
    },
  },
  thresholds: {
    'http_req_duration{group:::GET /prices}': ['p(99)<700'],
    'http_req_duration{group:::GET /history/:asset}': ['p(99)<900'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const priceRes = http.get(`${BASE_URL}/api/v1/prices`, { headers });
  latencies.prices.add(priceRes.timings.duration);
  check(priceRes, { 'prices 200': (r) => r.status === 200 });

  const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
  const historyRes = http.get(`${BASE_URL}/api/v1/history/${asset}?limit=10`, { headers });
  latencies.history.add(historyRes.timings.duration);
  check(historyRes, { 'history 200': (r) => r.status === 200 || r.status === 404 });

  sleep(0.1);
}
