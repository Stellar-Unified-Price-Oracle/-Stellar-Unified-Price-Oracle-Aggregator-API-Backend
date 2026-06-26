import { getDb, isDbAvailable } from './database';
import { logger } from '../middleware/logger';

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

class PriceRepository {
  async savePriceHistory(asset: string, price: string, decimals: number, source: string, timestamp: number): Promise<void> {
    if (!isDbAvailable()) return;

    try {
      const db = await getDb();
      await db.query(
        `INSERT INTO price_history (asset, price, decimals, source, timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (asset, source, timestamp) DO UPDATE SET price = $2`,
        [asset.toUpperCase(), price, decimals, source, timestamp]
      );
    } catch (error) {
      logger.error('Failed to save price history:', error);
    }
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
      const params: any[] = [asset.toUpperCase()];
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

      const result = await db.query(query, params);
      return result.rows.map((row: any) => ({
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
      const result = await db.query(
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
      const result = await db.query(
        'SELECT * FROM aggregator_state WHERE asset = $1',
        [asset.toUpperCase()]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        asset: row.asset,
        latestPrice: row.latest_price,
        latestTimestamp: row.latest_timestamp,
        confidence: row.confidence,
        activeSources: JSON.parse(row.active_sources || '[]'),
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
      const result = await db.query('SELECT DISTINCT asset FROM aggregator_state WHERE active = true');
      return result.rows.map((row: any) => row.asset);
    } catch (error) {
      logger.error('Failed to get all assets:', error);
      return [];
    }
  }
}

export const priceRepository = new PriceRepository();
