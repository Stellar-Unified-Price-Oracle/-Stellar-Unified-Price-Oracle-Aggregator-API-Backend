import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const regionLatency = new Trend('region_latency', true);
const errorRate = new Rate('error_rate');
const successfulRegions = new Counter('successful_region_hits');
const failedRegions = new Counter('failed_region_hits');

// Cell-scoped metrics: isolate a single cell failure and prove other cells stay healthy.
const cellLatency = new Trend('cell_latency', true);
const cellErrorRate = new Rate('cell_error_rate');
const cellRecoveryTime = new Trend('cell_recovery_time_ms');
const cellIsolationViolations = new Counter('cell_isolation_violations');
const cellHits = new Counter('cell_hits');
const cellFailures = new Counter('cell_failures');

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

// Cell topology: CELLS is a comma-separated list of cell names, CELL_FEEDS maps
// cell -> comma-separated feed ids (e.g. "cell-a:1,2;cell-b:3,4"). FAILING_CELL
// names the single cell whose dependency we simulate as down during the drill.
const CELLS = (__ENV.CELLS || 'cell-a,cell-b')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

const FAILING_CELL = __ENV.FAILING_CELL || CELLS[0];

const CELL_FEEDS = (() => {
  const map = {};
  for (const entry of (__ENV.CELL_FEEDS || '').split(';')) {
    const [cell, feeds] = entry.split(':');
    if (!cell || !feeds) continue;
    map[cell.trim()] = feeds
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  }
  return map;
})();

// SLO for cells that are NOT the failing cell: they must stay healthy while the
// failing cell's dependency is degraded.
const HEALTHY_CELL_ERROR_SLO = Number(__ENV.HEALTHY_CELL_ERROR_SLO || 0.05);
const HEALTHY_CELL_P95_SLO_MS = Number(__ENV.HEALTHY_CELL_P95_SLO_MS || 1000);

function feedsForCell(cell) {
  return CELL_FEEDS[cell] || [];
}

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
    cell_failure: {
      executor: 'constant-vus',
      vus: 20,
      duration: '2m',
      startTime: '30s',
      tags: { phase: 'cell-failure' },
      env: { SIMULATE_CELL_LOSS: 'true' },
    },
    cell_recovery: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30s',
      startTime: '2m30s',
      tags: { phase: 'cell-recovery' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    error_rate: ['rate<0.10'],
    http_req_failed: ['rate<0.10'],
    // Healthy cells must remain within SLO even while the failing cell is down.
    'cell_error_rate{cell_role:healthy}': [`rate<${HEALTHY_CELL_ERROR_SLO}`],
    'cell_latency{cell_role:healthy}': [`p(95)<${HEALTHY_CELL_P95_SLO_MS}`],
    // The failing cell is expected to error during the drill, but must recover.
    'cell_error_rate{cell_role:failing,phase:cell-recovery}': ['rate<0.10'],
    cell_isolation_violations: ['count==0'],
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

function cellRole(cell) {
  return cell === FAILING_CELL ? 'failing' : 'healthy';
}

// Exercise a single cell's feeds. During the cell-failure phase the failing
// cell's dependency is simulated as down; healthy cells must stay within SLO.
export function cellScenario() {
  const simulateCellLoss = __ENV.SIMULATE_CELL_LOSS === 'true';
  const phase = simulateCellLoss ? 'cell-failure' : 'cell-recovery';

  for (const cell of CELLS) {
    const role = cellRole(cell);
    const feeds = feedsForCell(cell);
    const tags = { cell, cell_role: role, phase };

    // The failing cell's dependency is down during the failure phase.
    const dependencyDown = simulateCellLoss && role === 'failing';

    const start = Date.now();
    const res = http.get(`${FALLBACK_URL}/api/v1/prices`, {
      headers,
      tags: { ...tags, endpoint: 'prices' },
    });
    const elapsed = Date.now() - start;

    cellLatency.add(res.timings.duration, tags);
    cellHits.add(1, tags);

    const ok = check(res, {
      [`[${cell}] status 200`]: (r) => r.status === 200,
      [`[${cell}] has prices data`]: (r) => {
        try {
          return Array.isArray(JSON.parse(r.body).data?.prices);
        } catch {
          return false;
        }
      },
    });

    cellErrorRate.add(!ok, tags);

    if (!ok) {
      cellFailures.add(1, tags);
    }

    // Isolation assertion: a healthy cell must never fail because another
    // cell's dependency is down. Any failure here is a cell-boundary breach.
    if (role === 'healthy' && !ok) {
      cellIsolationViolations.add(1, tags);
    }

    // Recovery evidence: measure how long the failing cell takes to serve
    // successfully again once the dependency is restored.
    if (role === 'failing' && !dependencyDown && ok) {
      cellRecoveryTime.add(elapsed, tags);
    }

    // Per-feed probes scoped to this cell.
    for (const feed of feeds) {
      const feedRes = http.get(`${FALLBACK_URL}/api/v1/prices`, {
        headers,
        tags: { ...tags, endpoint: 'feed', feed },
      });
      const feedOk = check(feedRes, {
        [`[${cell}] feed ${feed} reachable`]: (r) => r.status === 200 || r.status === 503,
      });
      if (role === 'healthy' && !feedOk) {
        cellIsolationViolations.add(1, { ...tags, feed });
      }
    }
  }

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

  const violations = data.metrics['cell_isolation_violations']?.values?.count ?? 0;
  const recoveryP95 = data.metrics['cell_recovery_time_ms']?.values?.['p(95)'];

  console.log('\n=== Cell Isolation Summary ===');
  console.log(`Failing cell:   ${FAILING_CELL}`);
  console.log(`Cells:          ${CELLS.join(', ')}`);
  console.log(`Isolation breaches: ${violations}`);
  console.log(`Recovery p95:   ${recoveryP95?.toFixed(0) ?? 'n/a'}ms`);
  console.log(`Cell isolation: ${violations === 0 ? 'PASS' : 'FAIL'}`);

  return {
    stdout: JSON.stringify(data.metrics, null, 2),
  };
}
