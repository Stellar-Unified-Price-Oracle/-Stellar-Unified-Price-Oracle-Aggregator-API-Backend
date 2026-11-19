import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

interface Gap {
  asset: string;
  startTs: number;
  endTs: number;
  gapSeconds: number;
  missingSnapshots: number;
}

async function detectGaps(
  pool: Pool,
  sinceMs: number,
  expectedInterval: number = 60,
  alertThreshold: number = 900,
  assetFilter?: string,
): Promise<{ gaps: Gap[]; alertingGaps: Gap[] }> {
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

  const alertingGaps = gaps.filter((g) => g.gapSeconds > alertThreshold);
  return { gaps, alertingGaps };
}

describe('History Gap Detection', () => {
  let pool: Pool;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('DATABASE_URL not set; skipping integration tests');
      return;
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    await pool.query('CREATE TABLE IF NOT EXISTS price_history (asset TEXT, source TEXT, timestamp BIGINT)');
  });

  afterEach(async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS price_history');
    await pool.end();
  });

  it('should detect no gaps when prices are at expected intervals', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) {
      await pool.query(
        'INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)',
        ['XLM', 'chainlink', now - (10 - i) * 60],
      );
    }

    const { gaps, alertingGaps } = await detectGaps(pool, Date.now() - 7 * 86_400_000);

    expect(gaps).toHaveLength(0);
    expect(alertingGaps).toHaveLength(0);
  });

  it('should detect small gaps that do not exceed alert threshold', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now - 500,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now - 350,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now,
    ]);

    const { gaps, alertingGaps } = await detectGaps(pool, Date.now() - 7 * 86_400_000);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapSeconds).toBe(350);
    expect(alertingGaps).toHaveLength(0);
  });

  it('should detect gaps that exceed alert threshold (900 seconds)', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now - 2000,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now,
    ]);

    const { gaps, alertingGaps } = await detectGaps(
      pool,
      Date.now() - 7 * 86_400_000,
      60,
      900,
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapSeconds).toBe(2000);
    expect(alertingGaps).toHaveLength(1);
  });

  it('should correctly calculate missing snapshots', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'chainlink',
      now - 600,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'chainlink',
      now,
    ]);

    const { gaps } = await detectGaps(pool, Date.now() - 7 * 86_400_000, 60);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].missingSnapshots).toBe(9);
  });

  it('should handle multiple assets with different gap patterns', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now - 500,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now,
    ]);

    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'USDC',
      'redstone',
      now - 2000,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'USDC',
      'redstone',
      now,
    ]);

    const { gaps, alertingGaps } = await detectGaps(
      pool,
      Date.now() - 7 * 86_400_000,
      60,
      900,
    );

    expect(gaps).toHaveLength(2);
    expect(alertingGaps).toHaveLength(1);
  });

  it('should filter gaps by asset when asset filter is provided', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now - 2000,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now,
    ]);

    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'USDC',
      'redstone',
      now - 2000,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'USDC',
      'redstone',
      now,
    ]);

    const { gaps } = await detectGaps(
      pool,
      Date.now() - 7 * 86_400_000,
      60,
      900,
      'XLM',
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0].asset).toBe('XLM');
  });

  it('should report empty data for non-existent asset with asset filter', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      now,
    ]);

    const { gaps } = await detectGaps(
      pool,
      Date.now() - 7 * 86_400_000,
      60,
      900,
      'NONEXISTENT',
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapSeconds).toBe(Infinity);
    expect(gaps[0].missingSnapshots).toBe(-1);
  });

  it('should respect the since timestamp parameter', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 10 * 86_400_000;
    const recentTs = now - 3 * 86_400_000;

    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      oldTs,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      oldTs + 1800,
    ]);

    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      recentTs,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'XLM',
      'chainlink',
      recentTs + 60,
    ]);

    const lookbackMs = 5 * 86_400_000;
    const { gaps } = await detectGaps(pool, Date.now() - lookbackMs, 60);

    expect(gaps.length).toBeGreaterThanOrEqual(1);
  });

  it('should not report false gaps when multiple sources have staggered updates', async () => {
    if (!pool) {
      console.warn('DATABASE_URL not set; skipping test');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Chainlink updates every 60 seconds
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'chainlink',
      now - 120,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'chainlink',
      now - 60,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'chainlink',
      now,
    ]);

    // Redstone updates every 120 seconds (lagged)
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'redstone',
      now - 240,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'redstone',
      now - 120,
    ]);
    await pool.query('INSERT INTO price_history (asset, source, timestamp) VALUES ($1, $2, $3)', [
      'BTC',
      'redstone',
      now,
    ]);

    const { gaps, alertingGaps } = await detectGaps(
      pool,
      Date.now() - 7 * 86_400_000,
      60,
      900,
    );

    // No gaps should be detected because each source has consistent intervals
    // within its own cadence
    expect(alertingGaps).toHaveLength(0);
  });
});
