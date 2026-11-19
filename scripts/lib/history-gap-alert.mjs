export const GAP_ALERT_TITLE_PREFIX = 'price_history gap detected';
export const GAP_ALERT_LABELS = ['data', 'alert'];
export const GAPS_EXIT_CODE = 1;

export function shouldOpenGapAlert(exitCode) {
  return Number(exitCode) === GAPS_EXIT_CODE;
}

export function parseGapReport(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Gap report is empty');
  }
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error('Gap report does not contain a JSON object');
  }
  const report = JSON.parse(raw.slice(start));
  if (!Array.isArray(report.gaps) || typeof report.alertThreshold !== 'number') {
    throw new Error('Gap report is missing gaps[] or alertThreshold');
  }
  return report;
}

export function alertingGaps(report) {
  return report.gaps.filter((g) => g.gapSeconds === null || g.gapSeconds > report.alertThreshold);
}

function iso(ts) {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : 'unknown';
}

export function backfillCommand(gap) {
  return `npm run history:backfill -- --asset ${gap.asset} --from ${gap.startTs} --to ${gap.endTs}`;
}

export function renderGapAlertBody(report, { runUrl, maxRows = 25 } = {}) {
  const gaps = alertingGaps(report);
  const shown = gaps.slice(0, maxRows);
  const lines = [
    `The scheduled history gap detector found ${gaps.length} gap(s) exceeding \`HISTORY_GAP_ALERT_SEC=${report.alertThreshold}\`.`,
    '',
    `Window scanned: from \`${report.windowStart}\` across ${report.scannedAssets} asset(s), ${report.scannedRows} row(s).`,
  ];
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  lines.push('', '| Asset | From | To | Gap (s) | ~Missing |', '| :--- | :--- | :--- | ---: | ---: |');
  for (const g of shown) {
    lines.push(`| ${g.asset} | ${iso(g.startTs)} | ${iso(g.endTs)} | ${g.gapSeconds ?? '∞'} | ${g.missingSnapshots} |`);
  }
  if (gaps.length > shown.length) {
    lines.push('', `_${gaps.length - shown.length} more gap(s) omitted; see the run log._`);
  }
  const commands = shown.filter((g) => g.startTs > 0 && g.endTs > 0).map(backfillCommand);
  lines.push('', 'Backfill from the `api/` directory with `DATABASE_URL` set:', '', '```sh', ...commands, '```');
  lines.push('', 'Then re-run the workflow; it comments here while the gap persists and the issue can be closed once a run passes.');
  lines.push('See `docs/runbooks/history-gap-alert.md`.');
  return lines.join('\n');
}

export function findOpenGapAlert(issues) {
  return issues.find((i) => !i.pull_request && i.state === 'open' && i.title.startsWith(GAP_ALERT_TITLE_PREFIX)) ?? null;
}

export function gapAlertTitle(now = new Date()) {
  return `${GAP_ALERT_TITLE_PREFIX} (${now.toISOString().slice(0, 10)})`;
}
