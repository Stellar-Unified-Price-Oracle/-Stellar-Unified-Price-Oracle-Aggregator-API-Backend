#!/usr/bin/env tsx
/**
 * Detect gaps in `price_history` and report them (issue #421).
 *
 * A "gap" is a stretch between two consecutive snapshots for the same asset that
 * is longer than the expected cadence. Gaps break VWAP/EMA consumers and audits.
 *
 * Usage:
 *   tsx api/scripts/detect-history-gaps.ts [--asset BTC] [--since 2026-01-01] [--json]
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

  const { rows } = await pool.query<{ asset: string; ts: string }>(
    `SELECT asset, timestamp::bigint AS ts
       FROM price_history
      WHERE ${where}
      ORDER BY asset, timestamp`,
    params,
  );
  await pool.end();

  const byAsset = new Map<string, number[]>();
  for (const row of rows) {
    const list = byAsset.get(row.asset) ?? [];
    list.push(Number(row.ts));
    byAsset.set(row.asset, list);
  }

  const gaps: Gap[] = [];
  for (const [asset, tsList] of byAsset) {
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
    if (tsList.length === 0 && assetFilter) {
      gaps.push({ asset, startTs: 0, endTs: 0, gapSeconds: Infinity, missingSnapshots: -1 });
    }
  }

  const alerting = gaps.filter((g) => g.gapSeconds > alertThreshold);
  const summary = {
    scannedAssets: byAsset.size,
    scannedRows: rows.length,
    windowStart: new Date(sinceMs).toISOString(),
    expectedInterval,
    alertThreshold,
    totalGaps: gaps.length,
    alertingGaps: alerting.length,
    gaps: gaps.sort((a, b) => b.gapSeconds - a.gapSeconds),
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `Scanned ${summary.scannedRows} rows across ${summary.scannedAssets} assets since ${summary.windowStart}`,
    );
    console.log(`Found ${gaps.length} gap(s); ${alerting.length} exceed ${alertThreshold}s`);
    for (const g of summary.gaps.slice(0, 50)) {
      const from = new Date(g.startTs * 1000).toISOString();
      const to = new Date(g.endTs * 1000).toISOString();
      const mark = g.gapSeconds > alertThreshold ? 'ALERT' : 'warn ';
      console.log(`  [${mark}] ${g.asset.padEnd(8)} ${from} -> ${to}  ${g.gapSeconds}s  (~${g.missingSnapshots} missing)`);
    }
    console.log(
      alerting.length > 0
        ? `\nBackfill with: npm run history:backfill -- --asset <ASSET> --from <startTs> --to <endTs>`
        : '\nNo gaps beyond threshold.',
    );
  }

  process.exit(alerting.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Gap detection failed:', err);
  process.exit(2);
});
