import { getDb, isDbAvailable, type PriceHistory } from '../infrastructure/database';
import { logger } from '../observability/logger';

interface AggregatorStateRow {
  asset: string;
  latest_price: string;
  latest_timestamp: number;
  confidence: number | string;
  active_sources: string | null;
}

export interface PriceRecord {
  asset: string;
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

export interface AggregatorStateRecord {
  asset: string;
  latestPrice: string;
  latestTimestamp: number;
  confidence: number;
  activeSources: string[];
}

const SAVE_PRICE_HISTORY_MAX_ATTEMPTS = 3;
const SAVE_PRICE_HISTORY_BASE_DELAY_MS = 50;

function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  if (!code) return true;
  return (
    code.startsWith('08') || // connection exceptions
    code === '40001' || // serialization failure
    code === '40P01' || // deadlock detected
    code === '53300' || // too many connections
    code === '57P01' || // admin shutdown
    code === '57P02' || // crash shutdown
    code === '57P03' // cannot connect now
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PriceRepository {
  async savePriceHistory(asset: string, price: string, decimals: number, source: string, timestamp: number): Promise<void> {
    if (!isDbAvailable()) return;

    const normalizedAsset = asset.toUpperCase();
    let lastError: unknown;

    for (let attempt = 1; attempt <= SAVE_PRICE_HISTORY_MAX_ATTEMPTS; attempt++) {
      try {
        const db = await getDb();
        await db.query(
          `INSERT INTO price_history (asset, price, decimals, source, timestamp)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (asset, source, timestamp) DO UPDATE SET price = $2`,
          [normalizedAsset, price, decimals, source, timestamp]
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SAVE_PRICE_HISTORY_MAX_ATTEMPTS && isTransientDbError(error)) {
          await delay(SAVE_PRICE_HISTORY_BASE_DELAY_MS * attempt);
          continue;
        }
        break;
      }
    }

    logger.error('Failed to save price history after retries', {
      asset: normalizedAsset,
      source,
      timestamp,
      attempts: SAVE_PRICE_HISTORY_MAX_ATTEMPTS,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  async getPriceHistory(
    asset: string,
    from?: number,
    to?: number,
    limit = 100
  ): Promise<PriceRecord[]> {
    if (!isDbAvailable()) return [];

    try {
      const db = await getDb();
      let query = 'SELECT * FROM price_history WHERE asset = $1';
      const params: unknown[] = [asset.toUpperCase()];
      let paramIndex = 2;

      if (from) {
        query += ` AND timestamp >= $${paramIndex}`;
        params.push(from);
        paramIndex++;
      }

      if (to) {
        query += ` AND timestamp <= $${paramIndex}`;
        params.push(to);
        paramIndex++;
      }

      query += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`;
      params.push(limit);

      const result = await db.readQuery<PriceHistory>(query, params);
      return result.rows.map((row) => ({
        asset: row.asset,
        price: row.price,
        decimals: row.decimals,
        source: row.source,
        timestamp: row.timestamp,
      }));
    } catch (error) {
      logger.error('Failed to get price history:', error);
      return [];
    }
  }

  async getLatestPrice(asset: string): Promise<PriceRecord | null> {
    if (!isDbAvailable()) return null;

    try {
      const db = await getDb();
      const result = await db.readQuery(
        'SELECT * FROM price_history WHERE asset = $1 ORDER BY timestamp DESC LIMIT 1',
        [asset.toUpperCase()]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        asset: row.asset,
        price: row.price,
        decimals: row.decimals,
        source: row.source,
        timestamp: row.timestamp,
      };
    } catch (error) {
      logger.error('Failed to get latest price:', error);
      return null;
    }
  }

  async saveAggregatorState(state: AggregatorStateRecord): Promise<void> {
    if (!isDbAvailable()) return;

    try {
      const db = await getDb();
      await db.query(
        `INSERT INTO aggregator_state (asset, latest_price, latest_timestamp, confidence, active_sources)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (asset) DO UPDATE SET
           latest_price = $2,
           latest_timestamp = $3,
           confidence = $4,
           active_sources = $5,
           last_update = CURRENT_TIMESTAMP`,
        [
          state.asset,
          state.latestPrice,
          state.latestTimestamp,
          state.confidence,
          JSON.stringify(state.activeSources)
        ]
      );
    } catch (error) {
      logger.error('Failed to save aggregator state:', error);
    }
  }

  async getAggregatorState(asset: string): Promise<AggregatorStateRecord | null> {
    if (!isDbAvailable()) return null;

    try {
      const db = await getDb();
      const result = await db.readQuery(
        'SELECT * FROM aggregator_state WHERE asset = $1',
        [asset.toUpperCase()]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0] as unknown as AggregatorStateRow;
      return {
        asset: row.asset,
        latestPrice: row.latest_price,
        latestTimestamp: row.latest_timestamp,
        confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence ?? 0),
        activeSources: JSON.parse(row.active_sources ?? '[]') as string[],
      };
    } catch (error) {
      logger.error('Failed to get aggregator state:', error);
      return null;
    }
  }

  async getAllAssets(): Promise<string[]> {
    if (!isDbAvailable()) return [];

    try {
      const db = await getDb();
      const result = await db.readQuery<{ asset: string }>('SELECT DISTINCT asset FROM aggregator_state WHERE active = true');
      return result.rows.map((row) => row.asset);
    } catch (error) {
      logger.error('Failed to get all assets:', error);
      return [];
    }
  }
}

export const priceRepository = new PriceRepository();
