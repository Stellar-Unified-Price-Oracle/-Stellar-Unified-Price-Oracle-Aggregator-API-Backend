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

/**
 * Parse a --from/--to value as either epoch seconds or an ISO-8601 timestamp.
 * Returns epoch seconds, or undefined when the value is absent/invalid.
 */
function parseTimestamp(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    console.error(`Invalid --${name} value "${value}": expected epoch seconds or an ISO timestamp`);
    process.exit(2);
  }
  return Math.floor(ms / 1000);
}

const from = parseTimestamp('from', flag('from'));
const to = parseTimestamp('to', flag('to'));

if (from !== undefined && to !== undefined && from >= to) {
  console.error(`Invalid range: --from (${from}) must be less than --to (${to})`);
  process.exit(2);
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

  // Per-asset tallies so the summary is actionable for each reported gap.
  const perAsset = new Map<string, { considered: number; inserted: number }>();

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
      const rowAsset = String(r.asset).toUpperCase();
      const res = await pool.query(
        `INSERT INTO price_history (asset, price, decimals, source, timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (asset, source, timestamp) DO NOTHING`,
        [rowAsset, String(r.price), r.decimals, r.source, r.timestamp],
      );
      const n = res.rowCount ?? 0;
      inserted += n;
      fileInserted += n;
      const tally = perAsset.get(rowAsset) ?? { considered: 0, inserted: 0 };
      tally.considered += 1;
      tally.inserted += n;
      perAsset.set(rowAsset, tally);
    }
    console.log(`${file}: considered ${rows.length}, inserted ${fileInserted}`);
  }

  await pool.end();

  if (dryRun) {
    console.log(`\n[dry-run] ${considered} row(s) would be replayed from ${files.length} file(s)`);
  } else {
    console.log(`\nBackfill complete: ${inserted}/${considered} new row(s) from ${files.length} file(s)`);
    if (perAsset.size > 0) {
      console.log('Per-asset summary (inserted / considered, skipped):');
      for (const [name, tally] of [...perAsset.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const skipped = tally.considered - tally.inserted;
        console.log(`  ${name}: ${tally.inserted} inserted, ${skipped} skipped (${tally.considered} considered)`);
      }
    }
  }

  const gapCmd = asset ? `npm run history:gaps -- --asset ${asset}` : 'npm run history:gaps';
  console.log(`\nRe-run \`${gapCmd}\` to confirm the gap is closed.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(2);
});
