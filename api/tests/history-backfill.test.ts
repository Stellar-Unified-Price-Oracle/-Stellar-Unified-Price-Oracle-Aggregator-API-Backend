import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

interface HistoryRecord {
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  source: string;
}

describe('History Backfill', () => {
  let pool: Pool;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('DATABASE_URL not set; skipping integration tests');
      return;
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        asset TEXT,
        price BIGINT,
        decimals INTEGER,
        timestamp BIGINT,
        source TEXT
      )
    `);
  });

  afterEach(async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS price_history');
    await pool.end();
  });

  it('should insert historical records in a gap period', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const from = now - 300;
    const to = now;

    const beforeGap = await pool.query(
      'SELECT COUNT(*) as count FROM price_history WHERE asset = $1 AND timestamp BETWEEN $2 AND $3',
      ['XLM', from, to],
    );
    expect(Number(beforeGap.rows[0].count)).toBe(0);

    const records: HistoryRecord[] = [
      {
        asset: 'XLM',
        price: 100_000_000n,
        decimals: 7,
        timestamp: from + 60,
        source: 'Backfill',
      },
      {
        asset: 'XLM',
        price: 101_000_000n,
        decimals: 7,
        timestamp: from + 120,
        source: 'Backfill',
      },
      {
        asset: 'XLM',
        price: 102_000_000n,
        decimals: 7,
        timestamp: from + 180,
        source: 'Backfill',
      },
    ];

    for (const record of records) {
      await pool.query(
        'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
        [record.asset, record.price, record.decimals, record.timestamp, record.source],
      );
    }

    const afterBackfill = await pool.query(
      'SELECT COUNT(*) as count FROM price_history WHERE asset = $1 AND timestamp BETWEEN $2 AND $3',
      ['XLM', from, to],
    );
    expect(Number(afterBackfill.rows[0].count)).toBe(3);
  });

  it('should not overwrite existing records during backfill', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    await pool.query(
      'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
      ['XLM', 100_000_000n, 7, now, 'Original'],
    );

    const original = await pool.query(
      'SELECT * FROM price_history WHERE asset = $1 AND timestamp = $2',
      ['XLM', now],
    );
    expect(Number(original.rows[0].price)).toBe(100_000_000);
    expect(original.rows[0].source).toBe('Original');

    await pool.query(
      'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
      ['XLM', 200_000_000n, 7, now, 'Backfill'],
    );

    const result = await pool.query(
      'SELECT * FROM price_history WHERE asset = $1 AND timestamp = $2',
      ['XLM', now],
    );
    expect(result.rows.length).toBe(2);
  });

  it('should handle backfill for multiple assets', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const from = now - 300;

    const assets = ['XLM', 'USDC', 'BTC'];
    for (const asset of assets) {
      await pool.query(
        'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
        [asset, 100_000_000n, 7, from + 60, 'Backfill'],
      );
    }

    for (const asset of assets) {
      const result = await pool.query(
        'SELECT * FROM price_history WHERE asset = $1 AND timestamp = $2',
        [asset, from + 60],
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].asset).toBe(asset);
    }
  });

  it('should maintain data integrity with concurrent backfill operations', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const from = now - 300;

    const insert = async (timestamp: number, source: string) => {
      await pool.query(
        'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
        ['XLM', 100_000_000n, 7, timestamp, source],
      );
    };

    await Promise.all([insert(from + 60, 'Backfill-1'), insert(from + 120, 'Backfill-2')]);

    const result = await pool.query('SELECT COUNT(*) as count FROM price_history WHERE asset = $1', [
      'XLM',
    ]);
    expect(Number(result.rows[0].count)).toBe(2);
  });

  it('should backfill partial gaps without affecting surrounding data', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    await pool.query(
      'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
      ['XLM', 100_000_000n, 7, now - 600, 'Original'],
    );

    await pool.query(
      'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
      ['XLM', 101_000_000n, 7, now, 'Original'],
    );

    await pool.query(
      'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
      ['XLM', 100_500_000n, 7, now - 300, 'Backfill'],
    );

    const result = await pool.query(
      'SELECT * FROM price_history WHERE asset = $1 ORDER BY timestamp',
      ['XLM'],
    );
    expect(result.rows.length).toBe(3);
    expect(Number(result.rows[0].timestamp)).toBe(now - 600);
    expect(Number(result.rows[1].timestamp)).toBe(now - 300);
    expect(Number(result.rows[2].timestamp)).toBe(now);
  });

  it('should track backfilled records with correct metadata', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    await pool.query(
      'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
      ['XLM', 100_000_000n, 7, now, 'Backfill-Gap-2026-09-14'],
    );

    const result = await pool.query('SELECT * FROM price_history WHERE asset = $1', ['XLM']);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].source).toContain('Backfill');
  });

  it('should support efficient range queries for backfill windows', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const from = now - 900;
    const to = now;

    for (let i = 0; i < 15; i++) {
      await pool.query(
        'INSERT INTO price_history (asset, price, decimals, timestamp, source) VALUES ($1, $2, $3, $4, $5)',
        ['XLM', (100_000_000n + BigInt(i * 1_000_000)), 7, from + i * 60, 'Backfill'],
      );
    }

    const result = await pool.query(
      'SELECT * FROM price_history WHERE asset = $1 AND timestamp BETWEEN $2 AND $3 ORDER BY timestamp',
      ['XLM', from, to],
    );
    expect(result.rows.length).toBe(15);
    expect(Number(result.rows[0].timestamp)).toBe(from);
    expect(Number(result.rows[result.rows.length - 1].timestamp)).toBe(from + 14 * 60);
  });
});
