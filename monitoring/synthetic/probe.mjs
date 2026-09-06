#!/usr/bin/env node
/**
 * Fully-external synthetic probe for the public API (#415).
 *
 * Runs from OUTSIDE the cluster (CI cron, or a serverless function in a
 * different cloud provider) so it can catch DNS, TLS, ingress, CDN and
 * total-cloud-outage failures that in-cluster health checks never see.
 *
 * Checks /prices, /history, /health and a WebSocket subscribe, then pushes
 * results to a Prometheus Pushgateway / remote-write endpoint in the
 * Prometheus text exposition format.
 *
 * Env:
 *   PROBE_BASE_URL      e.g. https://api.oracle.example.com
 *   PROBE_WS_URL        e.g. wss://api.oracle.example.com/ws
 *   PROBE_VANTAGE       label for this probe location, e.g. "eu-west-1"
 *   PUSHGATEWAY_URL     e.g. https://pushgateway.example.com
 */

import { WebSocket } from 'ws';

const BASE = process.env.PROBE_BASE_URL ?? 'https://api.oracle.example.com';
const WS_URL = process.env.PROBE_WS_URL ?? 'wss://api.oracle.example.com/ws';
const VANTAGE = process.env.PROBE_VANTAGE ?? 'unknown';
const PUSHGATEWAY = process.env.PUSHGATEWAY_URL ?? '';
const PAIR = 'XLM-USD';

/** @typedef {{ target: string, success: number, durationSeconds: number }} Result */

/** @returns {Promise<Result>} */
async function httpProbe(target, path, validate) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': `stellar-oracle-synthetic/${VANTAGE}` },
    });
    const body = await res.text();
    const ok = res.ok && validate(res, body);
    return { target, success: ok ? 1 : 0, durationSeconds: (performance.now() - start) / 1000 };
  } catch {
    return { target, success: 0, durationSeconds: (performance.now() - start) / 1000 };
  }
}

/** @returns {Promise<Result>} */
function wsProbe() {
  const start = performance.now();
  return new Promise((resolve) => {
    const done = (success) =>
      resolve({ target: 'ws-subscribe', success, durationSeconds: (performance.now() - start) / 1000 });
    let settled = false;
    const finish = (s) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* noop */ }
      done(s);
    };
    const ws = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });
    const timer = setTimeout(() => finish(0), 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', pair: PAIR })));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'price' || typeof msg.price === 'number') {
          clearTimeout(timer);
          finish(1);
        }
      } catch { /* ignore non-JSON frames */ }
    });
    ws.on('error', () => { clearTimeout(timer); finish(0); });
  });
}

function toPrometheus(results) {
  const lines = [
    '# HELP probe_success Whether the synthetic probe succeeded (1) or failed (0)',
    '# TYPE probe_success gauge',
    '# HELP probe_duration_seconds Wall-clock duration of the synthetic probe',
    '# TYPE probe_duration_seconds gauge',
  ];
  for (const r of results) {
    const labels = `probe_target="${r.target}",vantage="${VANTAGE}",source="external"`;
    lines.push(`probe_success{${labels}} ${r.success}`);
    lines.push(`probe_duration_seconds{${labels}} ${r.durationSeconds.toFixed(4)}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const results = await Promise.all([
    httpProbe('prices', `/api/v1/prices?pair=${PAIR}`, (_res, body) => body.includes('"price"')),
    httpProbe(
      'history',
      `/api/v1/history?pair=${PAIR}&interval=1h&limit=10`,
      (_res, body) => {
        try { return Array.isArray(JSON.parse(body)); } catch { return false; }
      },
    ),
    httpProbe('health', '/health', (_res, body) => body.includes('"status"') && body.includes('ok')),
    wsProbe(),
  ]);

  const text = toPrometheus(results);
  process.stdout.write(text);

  if (PUSHGATEWAY) {
    await fetch(`${PUSHGATEWAY}/metrics/job/synthetic-external/vantage/${VANTAGE}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: text,
    });
  }

  const anyFailed = results.some((r) => r.success === 0);
  process.exit(anyFailed ? 1 : 0);
}

main();
