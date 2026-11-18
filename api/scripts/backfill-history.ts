#!/usr/bin/env tsx
/**
 * Backfill `price_history` from source snapshot files (issue #421).
 *
 * Pairs with `detect-history-gaps.ts`: once a gap is reported, replay the source
 * data that covers it. Inserts are idempotent via the unique
 * (asset, source, timestamp) index, so re-running is safe.
 *
 * Source files are `history-<asset>.json` arrays of
 *   { asset, price, decimals, source, timestamp }   // timestamp = epoch seconds
 * found under a data directory (default: repo `data/`, then `api/data/`).
 *
 * Usage:
 *   tsx api/scripts/backfill-history.ts --asset BTC --from 1719378000 --to 1719378600 [dataDir]
 *   tsx api/scripts/backfill-history.ts --all [dataDir]        # replay every file
 *   tsx api/scripts/backfill-history.ts --asset BTC --dry-run
 *
 * Requires DATABASE_URL.
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
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const asset = flag('asset')?.toUpperCase();
const from = flag('from') ? Number(flag('from')) : undefined;
const to = flag('to') ? Number(flag('to')) : undefined;

// Gap thresholds, mirroring detect-history-gaps.ts so a backfill can verify itself.
const EXPECTED_INTERVAL_SEC = Number(process.env.HISTORY_EXPECTED_INTERVAL_SEC ?? 60);
const GAP_ALERT_SEC = Number(process.env.HISTORY_GAP_ALERT_SEC ?? 900);

const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(asset|from|to)$/));
const candidateDirs = [
  positional[0],
  path.resolve(__dirname, '../../data'),
  path.resolve(__dirname, '../data'),
  path.resolve(__dirname, '../../services/aggregator/data'),
].filter(Boolean) as string[];

const dataDir = candidateDirs.find((d) => fs.existsSync(d));
if (!dataDir) {
  console.error(`No data directory found. Looked in:\n  ${candidateDirs.join('\n  ')}`);
  process.exit(2);
}

interface Snapshot {
  asset: string;
  price: string | number;
  decimals: number;
  source: string;
  timestamp: number;
}

function loadFile(file: string): Snapshot[] {
  const raw = fs.readFileSync(file, 'utf-8');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

interface RemainingGap {
  asset: string;
  source: string;
  previous: number;
  next: number;
  gapSec: number;
}

/**
 * Re-query price_history for the replayed range and report gaps that still
 * exceed HISTORY_GAP_ALERT_SEC. Mirrors the detector's interval logic.
 */
async function findRemainingGaps(
  pool: Pool,
  assets: string[],
  rangeFrom: number | undefined,
  rangeTo: number | undefined,
): Promise<RemainingGap[]> {
  const gaps: RemainingGap[] = [];
  for (const a of assets) {
    const params: unknown[] = [a];
    let where = 'asset = $1';
    if (rangeFrom !== undefined) {
      params.push(rangeFrom);
      where += ` AND timestamp >= $${params.length}`;
    }
    if (rangeTo !== undefined) {
      params.push(rangeTo);
      where += ` AND timestamp <= $${params.length}`;
    }
    const res = await pool.query(
      `SELECT source, timestamp FROM price_history WHERE ${where} ORDER BY source, timestamp`,
      params,
    );
    let prev: { source: string; timestamp: number } | undefined;
    for (const row of res.rows as { source: string; timestamp: number | string }[]) {
      const ts = Number(row.timestamp);
      if (prev && prev.source === row.source) {
        const gapSec = ts - prev.timestamp;
        if (gapSec > GAP_ALERT_SEC) {
          gaps.push({ asset: a, source: row.source, previous: prev.timestamp, next: ts, gapSec });
        }
      }
      prev = { source: row.source, timestamp: ts };
    }
  }
  return gaps;
}

async function main(): Promise<void> {
  if (!all && !asset) {
    console.error('Pass --asset <ASSET> (optionally --from/--to epoch seconds) or --all');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => /^history-.+\.json$/i.test(f))
    .filter((f) => all || f.toLowerCase() === `history-${asset!.toLowerCase()}.json`);

  if (files.length === 0) {
    console.error(`No matching history-*.json files in ${dataDir}`);
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let considered = 0;
  let inserted = 0;

  for (const file of files) {
    const rows = loadFile(path.join(dataDir, file)).filter((r) => {
      if (from !== undefined && r.timestamp < from) return false;
      if (to !== undefined && r.timestamp > to) return false;
      return true;
    });
    considered += rows.length;
    if (dryRun) {
      console.log(`[dry-run] ${file}: ${rows.length} row(s) in range`);
      continue;
    }
    for (const r of rows) {
      const res = await pool.query(
        `INSERT INTO price_history (asset, price, decimals, source, timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (asset, source, timestamp) DO NOTHING`,
        [String(r.asset).toUpperCase(), String(r.price), r.decimals, r.source, r.timestamp],
      );
      inserted += res.rowCount ?? 0;
    }
    console.log(`${file}: considered ${rows.length}, inserted ${inserted}`);
  }

  console.log(
    dryRun
      ? `\n[dry-run] ${considered} row(s) would be replayed from ${files.length} file(s)`
      : `\nBackfill complete: ${inserted}/${considered} new row(s) from ${files.length} file(s)`,
  );

  if (dryRun) {
    await pool.end();
    console.log('Re-run `npm run history:gaps` to confirm the gap is closed.');
    return;
  }

  // Verify the replay actually closed the gaps for the targeted range.
  const assets = all
    ? files.map((f) => f.replace(/^history-/i, '').replace(/\.json$/i, '').toUpperCase())
    : [asset!];
  const remaining = await findRemainingGaps(pool, assets, from, to);
  await pool.end();

  if (remaining.length === 0) {
    console.log(
      `\nVerified: no gaps > ${GAP_ALERT_SEC}s remain for ${assets.join(', ')}` +
        (from !== undefined || to !== undefined ? ` in range [${from ?? '-'}, ${to ?? '-'}]` : ''),
    );
    return;
  }

  console.error(
    `\n${remaining.length} gap(s) still exceed HISTORY_GAP_ALERT_SEC=${GAP_ALERT_SEC}s ` +
      `(expected interval ${EXPECTED_INTERVAL_SEC}s):`,
  );
  for (const g of remaining) {
    console.error(
      `  ${g.asset} ${g.source}: ${g.previous} -> ${g.next} (${g.gapSec}s)`,
    );
  }
  console.error('Backfill did not close all gaps; extend the range or source data and retry.');
  process.exit(1);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(2);
});
