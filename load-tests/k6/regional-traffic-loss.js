import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const regionLatency = new Trend('region_latency', true);
const errorRate = new Rate('error_rate');
const successfulRegions = new Counter('successful_region_hits');
const failedRegions = new Counter('failed_region_hits');

const REGION_URLS = (__ENV.REGION_URLS || '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

const FALLBACK_URL = __ENV.BASE_URL || 'http://localhost:3000';

const regions =
  REGION_URLS.length >= 2
    ? REGION_URLS
    : [FALLBACK_URL, FALLBACK_URL];

const API_KEY = __ENV.API_KEY || '';
const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

export const options = {
  scenarios: {
    full_load: {
      executor: 'constant-vus',
      vus: 40,
      duration: '30s',
      tags: { phase: 'baseline' },
    },
    degraded_load: {
      executor: 'constant-vus',
      vus: 40,
      duration: '2m',
      startTime: '30s',
      tags: { phase: 'degraded' },
      env: { SIMULATE_LOSS: 'true' },
    },
    recovery_load: {
      executor: 'constant-vus',
      vus: 40,
      duration: '30s',
      startTime: '2m30s',
      tags: { phase: 'recovery' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    error_rate: ['rate<0.10'],
    http_req_failed: ['rate<0.10'],
  },
};

function pickRegion() {
  const simulateLoss = __ENV.SIMULATE_LOSS === 'true';
  if (simulateLoss && Math.random() < 0.5) {
    return regions[0];
  }
  const idx = Math.floor(Math.random() * regions.length);
  return regions[idx];
}

export default function () {
  const regionUrl = pickRegion();

  const res = http.get(`${regionUrl}/api/v1/prices`, {
    headers,
    tags: { region: regionUrl },
  });

  regionLatency.add(res.timings.duration, { region: regionUrl });

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has prices data': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).data?.prices);
      } catch {
        return false;
      }
    },
    'response under 1s': (r) => r.timings.duration < 1000,
  });

  if (ok) {
    successfulRegions.add(1, { region: regionUrl });
  } else {
    failedRegions.add(1, { region: regionUrl });
  }

  errorRate.add(!ok);

  const healthRes = http.get(`${regionUrl}/api/v1/health`, {
    headers,
    tags: { region: regionUrl, endpoint: 'health' },
  });

  check(healthRes, {
    'health check reachable': (r) => r.status === 200 || r.status === 503,
  });

  sleep(0.5);
}

export function setup() {
  for (const regionUrl of regions) {
    const res = http.get(`${regionUrl}/api/v1/health/live`);
    if (res.status !== 200) {
      console.warn(`Region ${regionUrl} not reachable (${res.status}) — drill will proceed`);
    }
  }
  return { regions };
}

export function handleSummary(data) {
  const p95 = data.metrics['http_req_duration']?.values?.['p(95)'];
  const errRate = data.metrics['error_rate']?.values?.rate;
  const hits = data.metrics['successful_region_hits']?.values?.count ?? 0;
  const misses = data.metrics['failed_region_hits']?.values?.count ?? 0;
  const total = hits + misses;
  const successPct = total > 0 ? ((hits / total) * 100).toFixed(1) : '0';

  console.log('\n=== Regional Traffic Loss Summary ===');
  console.log(`p95 latency:    ${p95?.toFixed(0) ?? 'n/a'}ms`);
  console.log(`Error rate:     ${((errRate ?? 0) * 100).toFixed(2)}%`);
  console.log(`Success rate:   ${successPct}%`);
  console.log(`Checks passed:  ${p95 < 1000 && errRate < 0.10 ? 'YES' : 'NO'}`);

  return {
    stdout: JSON.stringify(data.metrics, null, 2),
  };
}
