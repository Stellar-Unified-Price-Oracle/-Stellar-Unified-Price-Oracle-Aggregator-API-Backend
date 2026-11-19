import assert from 'node:assert/strict';
import test from 'node:test';
import { alertingGaps, backfillCommand, renderGapAlertBody } from '../history-gap-alert.mjs';

const summary = {
  scannedAssets: 2,
  scannedRows: 1000,
  windowStart: '2026-11-12T00:00:00.000Z',
  expectedInterval: 60,
  alertThreshold: 900,
  totalGaps: 3,
  alertingGaps: 2,
  gaps: [
    { asset: 'BTC', startTs: 1763500000, endTs: 1763503600, gapSeconds: 3600, missingSnapshots: 59 },
    { asset: 'XLM', startTs: 1763400000, endTs: 1763401200, gapSeconds: 1200, missingSnapshots: 19 },
    { asset: 'XLM', startTs: 1763300000, endTs: 1763300120, gapSeconds: 120, missingSnapshots: 1 },
  ],
};

test('alertingGaps keeps only gaps above the threshold', () => {
  assert.deepEqual(alertingGaps(summary).map((g) => g.asset), ['BTC', 'XLM']);
});

test('alertingGaps treats a serialized Infinity (null) as alerting', () => {
  const s = { alertThreshold: 900, gaps: [{ asset: 'ETH', startTs: 0, endTs: 0, gapSeconds: null, missingSnapshots: -1 }] };
  assert.equal(alertingGaps(s).length, 1);
});

test('backfillCommand fills in the real window', () => {
  assert.equal(
    backfillCommand(summary.gaps[0]),
    'npm run history:backfill -- --asset BTC --from 1763500000 --to 1763503600',
  );
});

test('backfillCommand falls back to a dry run when the window is unknown', () => {
  assert.equal(
    backfillCommand({ asset: 'ETH', startTs: 0, endTs: 0 }),
    'npm run history:backfill -- --asset ETH --dry-run',
  );
});

test('renderGapAlertBody lists each alerting window with its backfill command', () => {
  const body = renderGapAlertBody(summary, { runUrl: 'https://example.test/run/1' });
  assert.match(body, /found 2 gap\(s\) exceeding/);
  assert.match(body, /Run: https:\/\/example\.test\/run\/1/);
  assert.match(body, /\| BTC \| 2025-11-18T21:06:40\.000Z \| 2025-11-18T22:06:40\.000Z \| 1h \| 59 \|/);
  assert.match(body, /\| XLM \| .* \| 20m \| 19 \|/);
  assert.match(body, /--asset XLM --from 1763400000 --to 1763401200/);
  assert.doesNotMatch(body, /1763300000/);
  assert.doesNotMatch(body, /<ASSET>/);
});

test('renderGapAlertBody degrades gracefully without a summary', () => {
  const body = renderGapAlertBody(null, { threshold: 900 });
  assert.match(body, /HISTORY_GAP_ALERT_SEC=900/);
  assert.match(body, /summary was unavailable/);
});
