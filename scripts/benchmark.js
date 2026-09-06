#!/usr/bin/env node
/**
 * #110 — Performance Regression Detection
 *
 * Benchmarks key API endpoints and fails if any endpoint's p95 response time
 * exceeds a configurable threshold (default: 20 % above baseline).
 *
 * Usage:
 *   node scripts/benchmark.js                  # run with defaults
 *   BENCHMARK_BASE_URL=http://localhost:3000 \
 *   BENCHMARK_THRESHOLD_PCT=20 \
 *   BENCHMARK_ITERATIONS=30 \
 *     node scripts/benchmark.js
 *
 * Baseline values are read from scripts/benchmark-baseline.json (committed).
 * Run with --update-baseline to regenerate the file from the current results.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL = process.env.BENCHMARK_BASE_URL || 'http://localhost:3000';
const THRESHOLD_PCT = parseFloat(process.env.BENCHMARK_THRESHOLD_PCT || '20');
const ITERATIONS = parseInt(process.env.BENCHMARK_ITERATIONS || '20', 10);
const THROUGHPUT_TARGET_RPS = parseFloat(process.env.BENCHMARK_TARGET_TPS || '0');
const BASELINE_PATH = path.join(__dirname, 'benchmark-baseline.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

/** Endpoints to benchmark — add more as the API grows. */
const ENDPOINTS = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/api/v1/prices' },
  { method: 'GET', path: '/api/v2/prices' },
  { method: 'GET', path: '/api/v1/prices/XLM' },
  { method: 'GET', path: '/api/v2/prices/XLM' },
  { method: 'GET', path: '/metrics' },
];

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function request(method, urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = mod.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method },
      (res) => {
        res.resume(); // drain
        res.on('end', () => resolve({ status: res.statusCode, duration: Date.now() - start }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runBenchmark() {
  console.log(`Benchmarking ${BASE_URL} — ${ITERATIONS} iterations per endpoint\n`);

  const results = {};

  for (const ep of ENDPOINTS) {
    const key = `${ep.method} ${ep.path}`;
    const durations = [];
    let errors = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      try {
        const { duration } = await request(ep.method, BASE_URL + ep.path);
        durations.push(duration);
      } catch {
        errors++;
      }
    }

    if (durations.length === 0) {
      console.warn(`  SKIP  ${key} — all ${errors} requests failed (is the server running?)`);
      continue;
    }

    const totalDurationMs = durations.reduce((sum, current) => sum + current, 0);
    const throughputRps = durations.length > 0 && totalDurationMs > 0 ? durations.length / (totalDurationMs / 1000) : 0;
    results[key] = { ...stats(durations), errors, throughputRps };
    const s = results[key];
    console.log(
      `  ${key.padEnd(40)} p50=${s.p50}ms  p95=${s.p95}ms  p99=${s.p99}ms  rps=${throughputRps.toFixed(1)}  err=${errors}`
    );
  }

  // ---------------------------------------------------------------------------
  // Baseline update mode
  // ---------------------------------------------------------------------------
  if (UPDATE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2));
    console.log(`\nBaseline written to ${BASELINE_PATH}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Regression check
  // ---------------------------------------------------------------------------
  if (THROUGHPUT_TARGET_RPS > 0) {
    const maxRps = Object.values(results).reduce((max, entry) => Math.max(max, Number(entry.throughputRps || 0)), 0);
    if (maxRps < THROUGHPUT_TARGET_RPS) {
      console.error(`\nBenchmark throughput ${maxRps.toFixed(1)} rps is below target ${THROUGHPUT_TARGET_RPS} rps.`);
      process.exit(1);
    }
    console.log(`\nThroughput checkpoint: ${maxRps.toFixed(1)} rps (target ${THROUGHPUT_TARGET_RPS} rps)`);
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.warn(
      `\nNo baseline found at ${BASELINE_PATH}. ` +
        'Run with --update-baseline to create one. Skipping regression check.'
    );
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  let regressions = 0;

  console.log('\nRegression check (threshold: p95 must not exceed baseline by more than ' + THRESHOLD_PCT + '%):');

  for (const [key, curr] of Object.entries(results)) {
    const base = baseline[key];
    if (!base) {
      console.log(`  NEW   ${key} — no baseline; skipping`);
      continue;
    }
    const delta = ((curr.p95 - base.p95) / base.p95) * 100;
    const marker = delta > THRESHOLD_PCT ? 'FAIL' : 'PASS';
    if (marker === 'FAIL') regressions++;
    console.log(
      `  ${marker}  ${key.padEnd(40)} base=${base.p95}ms  curr=${curr.p95}ms  delta=${delta.toFixed(1)}%`
    );
  }

  if (regressions > 0) {
    console.error(`\n${regressions} regression(s) detected. Failing CI.`);
    process.exit(1);
  } else {
    console.log('\nAll endpoints within threshold. No regressions detected.');
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
