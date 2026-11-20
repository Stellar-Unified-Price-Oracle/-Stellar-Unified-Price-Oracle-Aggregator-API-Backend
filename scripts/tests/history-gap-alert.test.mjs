import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  alertingGaps,
  backfillCommand,
  gapAlertStatus,
  parseGapReport,
  renderGapAlertBody,
  syncGapAlert,
} from '../history-gap-alert.mjs';

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

test('parseGapReport accepts the detector --output summary', () => {
  assert.equal(parseGapReport(JSON.stringify(summary)).gaps.length, 3);
});

test('parseGapReport rejects empty, non-JSON and incomplete reports', () => {
  assert.throws(() => parseGapReport(''), /empty/);
  assert.throws(() => parseGapReport('npm warn something\n{'), /not valid JSON/);
  assert.throws(() => parseGapReport('{"gaps":[]}'), /alertThreshold/);
});

test('gapAlertStatus only alerts on exit 1 with a gap above the threshold', () => {
  assert.equal(gapAlertStatus(0, summary), 'none');
  assert.equal(gapAlertStatus(2, null), 'none');
  assert.equal(gapAlertStatus('1', summary), 'gap');
});

test('gapAlertStatus refuses a vague alert when the report is missing or has no alerting gap', () => {
  assert.throws(() => gapAlertStatus(1, null), /no readable report/);
  const quiet = { ...summary, gaps: [summary.gaps[2]] };
  assert.throws(() => gapAlertStatus(1, quiet), /no gap above the threshold/);
});

function fakeGithub(openIssues) {
  const calls = [];
  const rest = {
    issues: {
      listForRepo: Symbol('listForRepo'),
      create: async (args) => { calls.push(['create', args]); return { data: { number: 999 } }; },
      createComment: async (args) => { calls.push(['comment', args]); },
      update: async (args) => { calls.push(['update', args]); },
    },
  };
  return {
    calls,
    rest,
    paginate: async (fn, args) => {
      assert.equal(fn, rest.issues.listForRepo);
      assert.equal(args.state, 'open');
      assert.equal(args.labels, 'data,alert');
      return openIssues;
    },
  };
}

const repoRef = { owner: 'o', repo: 'r' };

test('syncGapAlert opens a new issue when none is open', async () => {
  const gh = fakeGithub([]);
  const res = await syncGapAlert(gh, { ...repoRef, status: 'gap', body: 'B', date: new Date('2026-11-19T00:00:00Z') });
  assert.deepEqual(res, { action: 'created', issue: 999 });
  assert.equal(gh.calls[0][1].title, 'price_history gap detected (2026-11-19)');
  assert.deepEqual(gh.calls[0][1].labels, ['data', 'alert']);
});

test('syncGapAlert comments on the newest open alert instead of opening another', async () => {
  const gh = fakeGithub([
    { number: 10, title: 'price_history gap detected (2026-11-17)' },
    { number: 12, title: 'price_history gap detected (2026-11-18)' },
    { number: 11, title: 'unrelated alert' },
    { number: 13, title: 'price_history gap detected (pr)', pull_request: {} },
  ]);
  const res = await syncGapAlert(gh, { ...repoRef, status: 'gap', body: 'B' });
  assert.deepEqual(res, { action: 'commented', issue: 12 });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment']);
});

test('syncGapAlert closes every open gap alert once the history is clean', async () => {
  const gh = fakeGithub([
    { number: 10, title: 'price_history gap detected (2026-11-17)' },
    { number: 12, title: 'price_history gap detected (2026-11-18)' },
    { number: 11, title: 'unrelated alert' },
  ]);
  const res = await syncGapAlert(gh, { ...repoRef, status: 'clean', runUrl: 'https://example.test/run/2' });
  assert.deepEqual(res, { action: 'closed', issues: [12, 10] });
  const updates = gh.calls.filter((c) => c[0] === 'update').map((c) => [c[1].issue_number, c[1].state]);
  assert.deepEqual(updates, [[12, 'closed'], [10, 'closed']]);
  assert.match(gh.calls[0][1].body, /example\.test\/run\/2/);
});

test('syncGapAlert is a no-op when clean and nothing is open', async () => {
  const gh = fakeGithub([]);
  assert.deepEqual(await syncGapAlert(gh, { ...repoRef, status: 'clean' }), { action: 'closed', issues: [] });
  assert.equal(gh.calls.length, 0);
});

const repoRoot = new URL('../../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/history-gap-detection.yml', repoRoot), 'utf8');

function stepBlock(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `workflow step "${name}" is missing`);
  const next = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

test('workflow only alerts on detector exit 1, never on any failure', () => {
  const alert = stepBlock('Alert on threshold breach');
  assert.match(alert, /if: .*steps\.detect\.outputs\.exit_code == '1'/);
  assert.doesNotMatch(alert, /if: failure\(\)\s*$/m);
  assert.match(alert, /scripts\/history-gap-alert\.mjs/);
  assert.match(alert, /gapAlertStatus\(/);
});

test('workflow reads the detector report from --output, not stdout', () => {
  const detect = stepBlock('Detect gaps');
  assert.match(detect, /--output "\$report"/);
  assert.doesNotMatch(detect, /> "\$RUNNER_TEMP\/gaps\.json"/);
});

test('workflow closes open alerts after a clean scan', () => {
  const close = stepBlock('Close resolved gap alerts');
  assert.match(close, /exit_code == '0'/);
  assert.match(close, /status: 'clean'/);
});

test('gap alert logic has a single implementation', () => {
  for (const stale of ['scripts/lib/history-gap-alert.mjs', 'api/scripts/history-gap-alert.cjs']) {
    assert.equal(existsSync(new URL(stale, repoRoot)), false, `${stale} duplicates scripts/history-gap-alert.mjs`);
  }
});
