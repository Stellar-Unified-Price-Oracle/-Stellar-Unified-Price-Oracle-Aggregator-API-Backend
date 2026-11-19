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
