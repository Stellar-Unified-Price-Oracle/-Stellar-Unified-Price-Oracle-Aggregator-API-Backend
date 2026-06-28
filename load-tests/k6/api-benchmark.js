import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const p95Latency = new Trend('p95_latency', true);
const errorRate = new Rate('error_rate');
const requestCount = new Counter('request_count');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || '';

const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      tags: { scenario: 'smoke' },
    },
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
      tags: { scenario: 'load' },
    },
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '20s', target: 50 },
        { duration: '10s', target: 0 },
      ],
      startTime: '2m30s',
      tags: { scenario: 'spike' },
    },
  },
  thresholds: {
    http_req_duration: ['p(50)<200', 'p(95)<500', 'p(99)<1000'],
    error_rate: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/prices`, { headers });
  requestCount.add(1);
  p95Latency.add(res.timings.duration);
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has prices': (r) => {
      try { return Array.isArray(JSON.parse(r.body).data?.prices); } catch { return false; }
    },
  });
  errorRate.add(!ok);
  sleep(1);
}

export function setup() {
  const res = http.get(`${BASE_URL}/api/v1/health/live`);
  if (res.status !== 200) {
    throw new Error(`API not reachable: ${res.status}`);
  }
}
