const MAX_LISTED_GAPS = 20;

function formatTs(ts) {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : 'n/a';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'no data';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', s || (!h && !m) ? `${s}s` : ''].filter(Boolean).join(' ');
}

export const GAPS_EXIT_CODE = 1;

export function parseGapReport(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Gap report is empty');
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Gap report is not valid JSON: ${err.message}`);
  }
  if (!report || !Array.isArray(report.gaps) || typeof report.alertThreshold !== 'number') {
    throw new Error('Gap report is missing gaps[] or alertThreshold');
  }
  return report;
}

export function gapAlertStatus(exitCode, report) {
  if (Number(exitCode) !== GAPS_EXIT_CODE) return 'none';
  if (!report) {
    throw new Error('Detector reported a gap but produced no readable report; refusing to file an alert without gap windows');
  }
  if (alertingGaps(report).length === 0) {
    throw new Error('Detector exited 1 but its report lists no gap above the threshold; refusing to file an alert');
  }
  return 'gap';
}

export function alertingGaps(summary) {
  const threshold = summary?.alertThreshold ?? Infinity;
  return (summary?.gaps ?? []).filter((g) => g.gapSeconds === null || g.gapSeconds > threshold);
}

export function backfillCommand(gap) {
  if (!(gap.startTs > 0 && gap.endTs > 0)) {
    return `npm run history:backfill -- --asset ${gap.asset} --dry-run`;
  }
  return `npm run history:backfill -- --asset ${gap.asset} --from ${gap.startTs} --to ${gap.endTs}`;
}

export function renderGapAlertBody(summary, { runUrl, threshold } = {}) {
  const gaps = alertingGaps(summary);
  const limit = summary?.alertThreshold ?? threshold;
  const lines = [
    `The scheduled history gap detector found ${gaps.length} gap(s) exceeding`,
    `\`HISTORY_GAP_ALERT_SEC=${limit}\`.`,
    '',
  ];
  if (runUrl) lines.push(`Run: ${runUrl}`, '');
  if (summary) {
    lines.push(
      `Scanned ${summary.scannedRows} rows across ${summary.scannedAssets} assets since ${summary.windowStart}.`,
      '',
    );
  }

  if (gaps.length === 0) {
    lines.push(
      'The detector summary was unavailable, so the offending windows are not listed.',
      'Open the run log, then backfill with `npm run history:backfill -- --asset <ASSET> --from <startTs> --to <endTs>`.',
    );
  } else {
    const shown = gaps.slice(0, MAX_LISTED_GAPS);
    lines.push('| Asset | From (UTC) | To (UTC) | Gap | ~Missing |', '| --- | --- | --- | --- | --- |');
    for (const g of shown) {
      lines.push(
        `| ${g.asset} | ${formatTs(g.startTs)} | ${formatTs(g.endTs)} | ${formatDuration(g.gapSeconds)} | ${g.missingSnapshots >= 0 ? g.missingSnapshots : 'n/a'} |`,
      );
    }
    if (gaps.length > shown.length) {
      lines.push('', `…and ${gaps.length - shown.length} more; see the run log for the full list.`);
    }
    lines.push('', 'Backfill from `api/`:', '', '```sh', ...shown.map(backfillCommand), '```');
  }

  lines.push('', 'Then re-run this workflow to confirm the gap is closed.');
  return lines.join('\n');
}

export const ALERT_TITLE_PREFIX = 'price_history gap detected';
export const ALERT_LABELS = ['data', 'alert'];

export async function findOpenGapAlerts(github, { owner, repo }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    labels: ALERT_LABELS.join(','),
    per_page: 100,
  });
  return issues
    .filter((i) => !i.pull_request && i.title.startsWith(ALERT_TITLE_PREFIX))
    .sort((a, b) => b.number - a.number);
}

export async function syncGapAlert(github, { owner, repo, status, body, runUrl, date = new Date() }) {
  const open = await findOpenGapAlerts(github, { owner, repo });

  if (status === 'gap') {
    const [current] = open;
    if (current) {
      await github.rest.issues.createComment({ owner, repo, issue_number: current.number, body });
      return { action: 'commented', issue: current.number };
    }
    const { data } = await github.rest.issues.create({
      owner,
      repo,
      title: `${ALERT_TITLE_PREFIX} (${date.toISOString().slice(0, 10)})`,
      labels: ALERT_LABELS,
      body,
    });
    return { action: 'created', issue: data.number };
  }

  if (status === 'clean') {
    for (const issue of open) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `No gap exceeds the alert threshold any more${runUrl ? ` (${runUrl})` : ''}. Closing.`,
      });
      await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
    }
    return { action: 'closed', issues: open.map((i) => i.number) };
  }

  throw new Error(`Unknown gap alert status: ${status}`);
}
