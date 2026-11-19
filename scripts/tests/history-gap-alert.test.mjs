import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alertingGaps,
  backfillCommand,
  findOpenGapAlert,
  gapAlertTitle,
  parseGapReport,
  renderGapAlertBody,
  shouldOpenGapAlert,
} from '../lib/history-gap-alert.mjs';

const report = {
  scannedAssets: 2,
  scannedRows: 1000,
  windowStart: '2026-11-12T00:00:00.000Z',
  expectedInterval: 60,
  alertThreshold: 900,
  totalGaps: 3,
  alertingGaps: 2,
  gaps: [
    { asset: 'BTC', startTs: 1763000000, endTs: 1763003600, gapSeconds: 3600, missingSnapshots: 59 },
    { asset: 'XLM', startTs: 1763100000, endTs: 1763100901, gapSeconds: 901, missingSnapshots: 14 },
    { asset: 'ETH', startTs: 1763200000, endTs: 1763200900, gapSeconds: 900, missingSnapshots: 14 },
  ],
};

test('only the detector gap exit code opens an alert', () => {
  assert.equal(shouldOpenGapAlert(1), true);
  assert.equal(shouldOpenGapAlert('1'), true);
  assert.equal(shouldOpenGapAlert(0), false);
  assert.equal(shouldOpenGapAlert(2), false);
  assert.equal(shouldOpenGapAlert(''), false);
  assert.equal(shouldOpenGapAlert(undefined), false);
});

test('alertingGaps excludes gaps exactly at the threshold', () => {
  assert.deepEqual(alertingGaps(report).map((g) => g.asset), ['BTC', 'XLM']);
});

test('alertingGaps treats a null gapSeconds (serialized Infinity) as alerting', () => {
  const r = { ...report, gaps: [{ asset: 'SOL', startTs: 0, endTs: 0, gapSeconds: null, missingSnapshots: -1 }] };
  assert.equal(alertingGaps(r).length, 1);
});

test('parseGapReport tolerates leading npm banner output', () => {
  const parsed = parseGapReport(`\n> @stellar-oracle/api history:gaps\n${JSON.stringify(report)}`);
  assert.equal(parsed.alertThreshold, 900);
});

test('parseGapReport rejects empty and malformed input', () => {
  assert.throws(() => parseGapReport(''), /empty/);
  assert.throws(() => parseGapReport('npm error code EUSAGE'), /JSON object/);
  assert.throws(() => parseGapReport('{"foo":1}'), /missing gaps/);
});

test('body lists concrete backfill commands instead of placeholders', () => {
  const body = renderGapAlertBody(report, { runUrl: 'https://example.test/run/1' });
  assert.match(body, /found 2 gap\(s\)/);
  assert.ok(body.includes(backfillCommand(report.gaps[0])));
  assert.ok(body.includes('--asset XLM --from 1763100000 --to 1763100901'));
  assert.ok(!body.includes('--asset ETH'));
  assert.ok(!body.includes('<ASSET>'));
  assert.ok(body.includes('https://example.test/run/1'));
});

test('body truncates long gap lists and skips commands for unknown ranges', () => {
  const many = {
    ...report,
    gaps: [
      { asset: 'SOL', startTs: 0, endTs: 0, gapSeconds: null, missingSnapshots: -1 },
      ...Array.from({ length: 30 }, (_, i) => ({ asset: `A${i}`, startTs: 100 + i, endTs: 2000 + i, gapSeconds: 1900, missingSnapshots: 30 })),
    ],
  };
  const body = renderGapAlertBody(many, { maxRows: 5 });
  assert.match(body, /26 more gap\(s\) omitted/);
  assert.ok(!body.includes('--asset SOL'));
  assert.match(body, /\| SOL \| unknown \| unknown \| ∞ \|/);
});

test('findOpenGapAlert reuses an open alert and ignores closed issues and PRs', () => {
  const issues = [
    { number: 1, state: 'closed', title: 'price_history gap detected (2026-11-01)' },
    { number: 2, state: 'open', title: 'price_history gap detected (2026-11-02)', pull_request: {} },
    { number: 3, state: 'open', title: 'Unrelated alert' },
    { number: 4, state: 'open', title: 'price_history gap detected (2026-11-03)' },
  ];
  assert.equal(findOpenGapAlert(issues).number, 4);
  assert.equal(findOpenGapAlert(issues.slice(0, 3)), null);
});

test('gapAlertTitle is dated', () => {
  assert.equal(gapAlertTitle(new Date('2026-11-19T10:00:00Z')), 'price_history gap detected (2026-11-19)');
});
