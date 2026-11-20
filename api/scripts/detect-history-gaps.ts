#!/usr/bin/env tsx
/**
 * Detect gaps in `price_history` and report them (issue #421).
 *
 * A "gap" is a stretch between two consecutive snapshots for the same asset that
 * is longer than the expected cadence. Gaps break VWAP/EMA consumers and audits.
 *
 * Usage:
 *   tsx api/scripts/detect-history-gaps.ts [--asset BTC] [--since 2026-01-01] [--json] [--output gaps.json]
 *
 * --output writes the JSON summary to a file (used by the CI alert step).
 *
 * Environment:
 *   DATABASE_URL                     required
 *   HISTORY_EXPECTED_INTERVAL_SEC    expected cadence between snapshots (default 60)
 *   HISTORY_GAP_ALERT_SEC           gap size that escalates to an alert / non-zero
 *                                    exit (default 900 = 15 min)
 *   HISTORY_LOOKBACK_DAYS            window to scan when --since is absent (default 7)
 *
 * Exit codes:
 *   0  no gap exceeded HISTORY_GAP_ALERT_SEC
 *   1  at least one gap exceeded the alert threshold
 *   2  usage / connection error
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const asJson = args.includes('--json');
const assetFilter = flag('asset')?.toUpperCase();
const outputPath = flag('output');
const expectedInterval = Number(process.env.HISTORY_EXPECTED_INTERVAL_SEC ?? 60);
const alertThreshold = Number(process.env.HISTORY_GAP_ALERT_SEC ?? 900);
const lookbackDays = Number(process.env.HISTORY_LOOKBACK_DAYS ?? 7);

const sinceArg = flag('since');
const sinceMs = sinceArg
  ? Date.parse(sinceArg)
  : Date.now() - lookbackDays * 86_400_000;
if (Number.isNaN(sinceMs)) {
  console.error(`Invalid --since value: ${sinceArg}`);
  process.exit(2);
}

interface Gap {
  asset: string;
  startTs: number;
  endTs: number;
  gapSeconds: number;
  missingSnapshots: number;
}

function backfillCommand(gap: Gap): string {
  return `npm run history:backfill -- --asset ${gap.asset} --from ${gap.startTs} --to ${gap.endTs}`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // `price_history.timestamp` is stored as epoch seconds by the API writer.
  const params: unknown[] = [Math.floor(sinceMs / 1000)];
  let where = 'timestamp >= $1';
  if (assetFilter) {
    params.push(assetFilter);
    where += ` AND asset = $${params.length}`;
  }

  const { rows } = await pool.query<{ asset: string; source: string; ts: string }>(
    `SELECT asset, source, timestamp::bigint AS ts
       FROM price_history
      WHERE ${where}
      ORDER BY asset, source, timestamp`,
    params,
  );
  await pool.end();

  // Group by (asset, source) to detect gaps only within the same source.
  const byAssetSource = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const key = `${row.asset}`;
    if (!byAssetSource.has(key)) {
      byAssetSource.set(key, new Map());
    }
    const sources = byAssetSource.get(key)!;
    if (!sources.has(row.source)) {
      sources.set(row.source, []);
    }
    sources.get(row.source)!.push(Number(row.ts));
  }

  const gaps: Gap[] = [];
  for (const [asset, sourceMap] of byAssetSource) {
    // Check if asset has no data at all
    if (sourceMap.size === 0 && assetFilter) {
      gaps.push({ asset, startTs: 0, endTs: 0, gapSeconds: Infinity, missingSnapshots: -1 });
      continue;
    }

    // For each source, detect gaps
    for (const [source, tsList] of sourceMap) {
      for (let i = 1; i < tsList.length; i += 1) {
        const delta = tsList[i] - tsList[i - 1];
        if (delta > expectedInterval * 1.5) {
          gaps.push({
            asset,
            startTs: tsList[i - 1],
            endTs: tsList[i],
            gapSeconds: delta,
            missingSnapshots: Math.max(0, Math.round(delta / expectedInterval) - 1),
          });
        }
      }
    }
  }

  const alerting = gaps.filter((g) => g.gapSeconds > alertThreshold);
  const sortedGaps = gaps.sort((a, b) => b.gapSeconds - a.gapSeconds);
  const summary = {
    scannedAssets: byAssetSource.size,
    scannedRows: rows.length,
    windowStart: new Date(sinceMs).toISOString(),
    expectedInterval,
    alertThreshold,
    totalGaps: sortedGaps.length,
    alertingGaps: alerting.length,
    gaps: sortedGaps.map((g) => ({
      ...g,
      startIso: new Date(g.startTs * 1000).toISOString(),
      endIso: new Date(g.endTs * 1000).toISOString(),
      backfillCommand: backfillCommand(g),
    })),
  };

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  }

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `Scanned ${summary.scannedRows} rows across ${summary.scannedAssets} assets since ${summary.windowStart}`,
    );
    console.log(`Found ${gaps.length} gap(s); ${alerting.length} exceed ${alertThreshold}s`);
    for (const g of summary.gaps.slice(0, 50)) {
      const mark = g.gapSeconds > alertThreshold ? 'ALERT' : 'warn ';
      console.log(`  [${mark}] ${g.asset.padEnd(8)} ${g.startIso} -> ${g.endIso}  ${g.gapSeconds}s  (~${g.missingSnapshots} missing)`);
    }
    if (alerting.length > 0) {
      console.log(`\n${alerting.length} alerting gap(s) require backfill:`);
      for (const g of alerting) {
        console.log(
          `  ${g.asset} ${new Date(g.startTs * 1000).toISOString()} -> ${new Date(g.endTs * 1000).toISOString()} (${g.gapSeconds}s)`,
        );
        console.log(`    ${backfillCommand(g)}`);
      }
    } else {
      console.log('\nNo gaps beyond threshold.');
    }
  }

  process.exit(alerting.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Gap detection failed:', err);
  process.exit(2);
});
