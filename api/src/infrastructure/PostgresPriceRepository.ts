import type { Pool } from 'pg';
import type {
  IPriceRepository,
  PriceRecord,
  PriceFilter,
} from '../domain/ports/IPriceRepository';
import {
  AssetPair,
  OracleSourceId,
  PriceDecimal,
  PriceId,
  TimestampMs,
} from '../types/branded';

/**
 * PostgresPriceRepository — infrastructure adapter implementing IPriceRepository.
 *
 * All SQL lives here; the domain/application layers never see raw queries.
 */
export class PostgresPriceRepository implements IPriceRepository {
  constructor(private readonly pool: Pool) {}

  async findLatest(pair: AssetPair): Promise<PriceRecord | null> {
    const { rows } = await this.pool.query<RawRow>(
      `SELECT id, pair, price, source, fetched_at, confidence
         FROM prices
        WHERE pair = $1
        ORDER BY fetched_at DESC
        LIMIT 1`,
      [pair]
    );
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async findHistory(filter: PriceFilter): Promise<PriceRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filter.pair) {
      conditions.push(`pair = $${idx++}`);
      values.push(filter.pair);
    }
    if (filter.source) {
      conditions.push(`source = $${idx++}`);
      values.push(filter.source);
    }
    if (filter.from) {
      conditions.push(`fetched_at >= $${idx++}`);
      values.push(filter.from);
    }
    if (filter.to) {
      conditions.push(`fetched_at <= $${idx++}`);
      values.push(filter.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;

    const { rows } = await this.pool.query<RawRow>(
      `SELECT id, pair, price, source, fetched_at, confidence
         FROM prices
        ${where}
        ORDER BY fetched_at DESC
        LIMIT $${idx}`,
      [...values, limit]
    );

    return rows.map(rowToRecord);
  }

  async save(record: Omit<PriceRecord, 'id'>): Promise<PriceRecord> {
    const { rows } = await this.pool.query<RawRow>(
      `INSERT INTO prices (pair, price, source, fetched_at, confidence)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, pair, price, source, fetched_at, confidence`,
      [record.pair, record.price, record.source, record.fetchedAt, record.confidence]
    );
    return rowToRecord(rows[0]);
  }

  async findById(id: PriceId): Promise<PriceRecord | null> {
    const { rows } = await this.pool.query<RawRow>(
      `SELECT id, pair, price, source, fetched_at, confidence
         FROM prices WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  pair: string;
  price: string;
  source: string;
  fetched_at: number;
  confidence: number;
}

function rowToRecord(row: RawRow): PriceRecord {
  return {
    id: PriceId(row.id),
    pair: AssetPair(row.pair),
    price: PriceDecimal(row.price),
    source: OracleSourceId(row.source),
    fetchedAt: TimestampMs(Number(row.fetched_at)),
    confidence: row.confidence,
  };
}
