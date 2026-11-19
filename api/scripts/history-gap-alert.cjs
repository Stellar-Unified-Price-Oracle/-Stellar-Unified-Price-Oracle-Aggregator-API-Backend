'use strict';

const MAX_ROWS = 25;
const TITLE_PREFIX = 'price_history gap detected';

function iso(ts) {
  return new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
}

function alertingGaps(summary) {
  return (summary.gaps || []).filter((g) => g.gapSeconds > summary.alertThreshold);
}

function buildAlertBody(summary, runUrl) {
  const gaps = alertingGaps(summary);
  const lines = [
    `The scheduled history gap detector found ${gaps.length} gap(s) exceeding`,
    `\`HISTORY_GAP_ALERT_SEC=${summary.alertThreshold}\` (window from ${summary.windowStart}).`,
    '',
    `Run: ${runUrl}`,
    '',
    '| Asset | From | To | Gap (s) | Backfill |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const g of gaps.slice(0, MAX_ROWS)) {
    const cmd = `npm run history:backfill -- --asset ${g.asset} --from ${g.startTs} --to ${g.endTs}`;
    lines.push(`| ${g.asset} | ${iso(g.startTs)} | ${iso(g.endTs)} | ${g.gapSeconds} | \`${cmd}\` |`);
  }
  if (gaps.length > MAX_ROWS) {
    lines.push('', `…and ${gaps.length - MAX_ROWS} more; see the run log for the full list.`);
  }
  lines.push('', 'Run the backfill commands from `api/`, then re-run this workflow to confirm the gaps are closed.');
  return lines.join('\n');
}

function findOpenAlert(issues) {
  return issues.find((i) => !i.pull_request && i.state === 'open' && i.title.startsWith(TITLE_PREFIX));
}

module.exports = { TITLE_PREFIX, alertingGaps, buildAlertBody, findOpenAlert };
