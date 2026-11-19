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

const GAP_ALERT_SEC = Number(process.env.HISTORY_GAP_ALERT_SEC ?? 900);

function validateRange(): void {
  if (from !== undefined && !Number.isFinite(from)) {
    console.error(`--from must be a finite epoch-seconds value, got "${flag('from')}"`);
    process.exit(2);
  }
  if (to !== undefined && !Number.isFinite(to)) {
    console.error(`--to must be a finite epoch-seconds value, got "${flag('to')}"`);
    process.exit(2);
  }
  if (from !== undefined && to !== undefined && from > to) {
    console.error(`--from (${from}) must be <= --to (${to})`);
    process.exit(2);
  }
}

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

async function main(): Promise<void> {
  if (!all && !asset) {
    console.error('Pass --asset <ASSET> (optionally --from/--to epoch seconds) or --all');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  validateRange();

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
    let fileInserted = 0;
    for (const r of rows) {
      const res = await pool.query(
        `INSERT INTO price_history (asset, price, decimals, source, timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (asset, source, timestamp) DO NOTHING`,
        [String(r.asset).toUpperCase(), String(r.price), r.decimals, r.source, r.timestamp],
      );
      fileInserted += res.rowCount ?? 0;
    }
    inserted += fileInserted;
    console.log(`${file}: considered ${rows.length}, inserted ${fileInserted}`);
  }

  if (!dryRun) {
    await verifyBackfill(pool);
  }

  await pool.end();
  console.log(
    dryRun
      ? `\n[dry-run] ${considered} row(s) would be replayed from ${files.length} file(s)`
      : `\nBackfill complete: ${inserted}/${considered} new row(s) from ${files.length} file(s)`,
  );
  console.log('Re-run `npm run history:gaps` to confirm the gap is closed.');
}

/**
 * Re-query price_history for the asset/range and report the rows present plus
 * any remaining gaps larger than HISTORY_GAP_ALERT_SEC, so the operator can
 * confirm closure before re-running the detector workflow (#885–#888).
 */
async function verifyBackfill(pool: Pool): Promise<void> {
  const verifyAsset = asset ?? (files.length === 1 ? files[0].replace(/^history-/i, '').replace(/\.json$/i, '').toUpperCase() : undefined);
  if (!verifyAsset) {
    console.log('\nVerification skipped: pass --asset to verify a single asset range.');
    return;
  }

  const params: unknown[] = [verifyAsset];
  let where = 'asset = $1';
  if (from !== undefined) {
    params.push(from);
    where += ` AND timestamp >= $${params.length}`;
  }
  if (to !== undefined) {
    params.push(to);
    where += ` AND timestamp <= $${params.length}`;
  }

  const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM price_history WHERE ${where}`, params);
  const present = (countRes.rows[0]?.n as number) ?? 0;
  console.log(`\nVerification for ${verifyAsset}${from !== undefined ? ` from ${from}` : ''}${to !== undefined ? ` to ${to}` : ''}: ${present} row(s) present`);

  if (from === undefined || to === undefined) {
    console.log('Pass both --from and --to to check for remaining gaps.');
    return;
  }

  const tsRes = await pool.query(
    `SELECT DISTINCT timestamp FROM price_history WHERE ${where} ORDER BY timestamp ASC`,
    params,
  );
  const timestamps = tsRes.rows.map((r) => Number(r.timestamp));

  const gaps: Array<{ start: number; end: number; size: number }> = [];
  let prev = from;
  for (const ts of timestamps) {
    if (ts - prev > GAP_ALERT_SEC) {
      gaps.push({ start: prev, end: ts, size: ts - prev });
    }
    prev = ts;
  }
  if (to - prev > GAP_ALERT_SEC) {
    gaps.push({ start: prev, end: to, size: to - prev });
  }

  if (gaps.length === 0) {
    console.log(`No gaps larger than ${GAP_ALERT_SEC}s remain in range.`);
  } else {
    console.log(`${gaps.length} gap(s) larger than ${GAP_ALERT_SEC}s remain:`);
    for (const g of gaps) {
      console.log(`  ${g.start} -> ${g.end} (${g.size}s)`);
    }
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(2);
});
