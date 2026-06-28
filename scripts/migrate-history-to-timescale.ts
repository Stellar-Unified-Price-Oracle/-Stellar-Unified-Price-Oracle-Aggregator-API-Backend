#!/usr/bin/env tsx
/**
 * Migrate historical price data from JSON files into the (TimescaleDB) database
 * (issue #42).
 *
 * - Reads every `history-<asset>.json` file from the candidate data directories.
 * - Transparently decrypts files encrypted at rest (issue #41).
 * - Inserts rows idempotently via the unique (asset, source, timestamp) index,
 *   so the migration can be re-run safely without duplicating data.
 *
 * Usage:
 *   tsx scripts/migrate-history-to-timescale.ts [dataDir]
 *
 * Requires DATABASE_URL to be set.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const CANDIDATE_DIRS = [
  process.argv[2],
  path.resolve(__dirname, '../data'),
  path.resolve(__dirname, '../services/aggregator/data'),
  path.resolve(__dirname, '../api/data'),
].filter(Boolean) as string[];

async function readHistoryFile(filePath: string): Promise<any[]> {
  const { isEncrypted, decrypt } = await import('../api/src/services/crypto');
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw) return [];
  const contents = isEncrypted(raw) ? decrypt(raw) : raw;
  const parsed = JSON.parse(contents);
  return Array.isArray(parsed) ? parsed : [];
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_history (
      id BIGSERIAL,
      asset VARCHAR(50) NOT NULL,
      price VARCHAR(255) NOT NULL,
      decimals INTEGER NOT NULL,
      source VARCHAR(100) NOT NULL,
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, timestamp)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_price_history_asset_source_ts
      ON price_history(asset, source, timestamp);
  `);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Aborting.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  await ensureSchema(pool);

  let inserted = 0;
  let skipped = 0;
  let filesProcessed = 0;
  const seenFiles = new Set<string>();

  for (const dir of CANDIDATE_DIRS) {
    if (!fs.existsSync(dir)) continue;

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('history-') && f.endsWith('.json'));

    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (seenFiles.has(file)) continue; // first matching dir wins per asset
      seenFiles.add(file);

      const asset = file.replace('history-', '').replace('.json', '').toUpperCase();
      console.log(`Migrating ${asset} from ${fullPath}...`);
      filesProcessed++;

      let records: any[] = [];
      try {
        records = await readHistoryFile(fullPath);
      } catch (err) {
        console.error(`  Failed to read ${file}:`, err instanceof Error ? err.message : err);
        continue;
      }

      for (const record of records) {
        if (record == null || record.timestamp == null || record.price == null) {
          skipped++;
          continue;
        }
        try {
          const result = await pool.query(
            `INSERT INTO price_history (asset, price, decimals, source, timestamp)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (asset, source, timestamp) DO NOTHING`,
            [
              asset,
              String(record.price),
              record.decimals ?? 8,
              record.source ?? 'unknown',
              record.timestamp,
            ],
          );
          if (result.rowCount && result.rowCount > 0) inserted++;
          else skipped++;
        } catch (err) {
          console.error(`  Failed to insert record for ${asset}:`, err instanceof Error ? err.message : err);
          skipped++;
        }
      }
    }
  }

  await pool.end();
  console.log(
    `\nMigration complete. Files: ${filesProcessed}, inserted: ${inserted}, skipped/duplicate: ${skipped}.`,
  );
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
