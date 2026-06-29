import { createGzip, createGunzip } from 'zlib';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createInterface } from 'readline';
import path from 'path';
import { Logger } from 'winston';
import { config } from '../config';
import { DatabaseClient, PriceHistory } from './database';
import { dbRecordsArchivedTotal } from '../middleware/metrics';

export interface ArchivalResult {
  archivedCount: number;
  deletedByRetention: number;
  files: string[];
  cutoffArchive: number;
  cutoffRetention: number | null;
  dryRun: boolean;
}

const SECONDS_PER_DAY = 86400;

/**
 * Lifecycle management for historical price records (issue #43).
 *
 * Records older than `archiveAfterDays` are streamed to gzip-compressed NDJSON
 * files in cold storage and then removed from the hot table. When
 * `retentionDays` is set, records older than that are hard-deleted (they are
 * assumed already archived). Archived files are restorable via `restore()`.
 */
export class ArchivalService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
  ) {}

  private get coldDir(): string {
    return path.resolve(config.db.archival.coldStorageDir);
  }

  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** Run a single archival + retention pass. */
  async runOnce(dryRun = false): Promise<ArchivalResult> {
    const now = this.nowSeconds();
    const cutoffArchive = now - config.db.archival.archiveAfterDays * SECONDS_PER_DAY;
    const retentionDays = config.db.archival.retentionDays;
    const cutoffRetention = retentionDays > 0 ? now - retentionDays * SECONDS_PER_DAY : null;

    const result: ArchivalResult = {
      archivedCount: 0,
      deletedByRetention: 0,
      files: [],
      cutoffArchive,
      cutoffRetention,
      dryRun,
    };

    if (dryRun) {
      result.archivedCount = await this.countOlderThan(cutoffArchive);
      if (cutoffRetention !== null) {
        result.deletedByRetention = await this.countOlderThan(cutoffRetention);
      }
      this.logger.info(
        `[dry-run] archival would move ${result.archivedCount} record(s); ` +
          `retention would purge ${result.deletedByRetention} record(s)`,
      );
      return result;
    }

    if (!existsSync(this.coldDir)) {
      mkdirSync(this.coldDir, { recursive: true });
    }

    const { count, files } = await this.archiveOlderThan(cutoffArchive);
    result.archivedCount = count;
    result.files = files;

    if (cutoffRetention !== null) {
      result.deletedByRetention = await this.purgeOlderThan(cutoffRetention);
    }

    this.logger.info(
      `Archival pass complete: archived ${result.archivedCount} record(s) to ${files.length} file(s); ` +
        `retention purged ${result.deletedByRetention} record(s)`,
    );
    return result;
  }

  private async countOlderThan(cutoff: number): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM price_history WHERE timestamp < $1',
      [cutoff],
    );
    return parseInt(res.rows[0]?.count || '0', 10);
  }

  /**
   * Stream rows older than `cutoff` to cold storage in batches, deleting each
   * batch transactionally after it has been durably written.
   */
  private async archiveOlderThan(cutoff: number): Promise<{ count: number; files: string[] }> {
    const batchSize = config.db.archival.batchSize;
    const files: string[] = [];
    let total = 0;
    let batchIndex = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.db.query<PriceHistory>(
        `SELECT id, asset, price, decimals, source, timestamp, created_at
           FROM price_history
          WHERE timestamp < $1
          ORDER BY timestamp ASC
          LIMIT $2`,
        [cutoff, batchSize],
      );
      const rows = res.rows;
      if (rows.length === 0) break;

      const fileName = `price_history_${cutoff}_${batchIndex}_${Date.now()}.ndjson.gz`;
      const filePath = path.join(this.coldDir, fileName);
      await this.writeNdjsonGz(filePath, rows);
      files.push(filePath);

      // Only delete what we durably archived (by id+timestamp PK).
      const ids = rows.map((r) => r.id);
      const timestamps = rows.map((r) => r.timestamp);
      await this.db.query(
        `DELETE FROM price_history ph
           USING unnest($1::bigint[], $2::bigint[]) AS d(id, ts)
          WHERE ph.id = d.id AND ph.timestamp = d.ts`,
        [ids, timestamps],
      );

      total += rows.length;
      dbRecordsArchivedTotal.inc(rows.length);
      batchIndex++;
    }

    return { count: total, files };
  }

  private async purgeOlderThan(cutoff: number): Promise<number> {
    const res = await this.db.query(
      'DELETE FROM price_history WHERE timestamp < $1',
      [cutoff],
    );
    return res.rowCount ?? 0;
  }

  private async writeNdjsonGz(filePath: string, rows: PriceHistory[]): Promise<void> {
    const source = Readable.from(rows.map((r) => `${JSON.stringify(r)}\n`));
    await pipeline(source, createGzip(), createWriteStream(filePath));
  }

  /**
   * Restore archived records back into price_history. Pass a specific archive
   * file, or omit to restore every file in cold storage. Re-inserts are
   * idempotent thanks to the unique (asset, source, timestamp) index.
   */
  async restore(file?: string): Promise<number> {
    const targets = file
      ? [path.isAbsolute(file) ? file : path.join(this.coldDir, file)]
      : this.listArchiveFiles();

    let restored = 0;
    for (const target of targets) {
      restored += await this.restoreFile(target);
    }
    this.logger.info(`Restored ${restored} record(s) from ${targets.length} archive file(s)`);
    return restored;
  }

  listArchiveFiles(): string[] {
    if (!existsSync(this.coldDir)) return [];
    return readdirSync(this.coldDir)
      .filter((f) => f.endsWith('.ndjson.gz'))
      .map((f) => path.join(this.coldDir, f))
      .sort();
  }

  private async restoreFile(filePath: string): Promise<number> {
    const rl = createInterface({
      input: createReadStream(filePath).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    let count = 0;
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const r = JSON.parse(trimmed) as PriceHistory;
      await this.db.query(
        `INSERT INTO price_history (asset, price, decimals, source, timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (asset, source, timestamp) DO NOTHING`,
        [r.asset, r.price, r.decimals, r.source, r.timestamp],
      );
      count++;
    }
    return count;
  }

  /** Start the scheduled archival loop (issue #43). */
  start(): void {
    if (!config.db.archival.enabled) return;
    const interval = config.db.archival.intervalMs;
    this.timer = setInterval(() => {
      this.runOnce(false).catch((err) => this.logger.error('Scheduled archival failed', err));
    }, interval);
    this.timer.unref?.();
    this.logger.info(
      `Data archival scheduled every ${Math.round(interval / 3600000)}h ` +
        `(archive >${config.db.archival.archiveAfterDays}d, ` +
        `retention ${config.db.archival.retentionDays || 'disabled'})`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
