import fs from 'fs';
import { createGzip, createGunzip } from 'zlib';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';
import { config } from '../infrastructure/config';
import { decrypt, encrypt, isEncrypted } from '../infrastructure/crypto';
import { logger } from '../observability/logger';
import { DATA_DIR, HISTORY_FILE, historyEncryptionEnabled, readHistoryFile, writeHistoryFile, type HistoricalPriceEntry } from './history';

const SECONDS_PER_DAY = 86400;

export interface FileArchivalResult {
  archivedCount: number;
  deletedByRetention: number;
  files: string[];
  cutoffArchive: number;
  cutoffRetention: number | null;
  dryRun: boolean;
}

type HistoryEntry = HistoricalPriceEntry;

/**
 * File-based data archival for historical price records (issue #43).
 *
 * Reads per-asset JSON history files from the hot data/ directory, moves
 * entries older than `archiveAfterDays` to gzip-compressed NDJSON files in
 * cold storage, then writes the pruned entries back. When `retentionDays`
 * is set, archive files older than the retention cutoff are deleted.
 * Archived files are restorable via `restore()`.
 */
export class FileArchivalService {
  private timer?: NodeJS.Timeout;
  private readonly coldDir: string;

  constructor() {
    this.coldDir = path.resolve(config.history.archival.coldStorageDir);
  }

  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** List all managed asset history files that exist on disk. */
  listAssetFiles(): string[] {
    if (!fs.existsSync(DATA_DIR)) return [];
    return config.assets
      .map((a) => HISTORY_FILE(a))
      .filter((fp) => fs.existsSync(fp));
  }

  /**
   * Run a single archival + retention pass across all per-asset history files.
   */
  async runOnce(dryRun = false): Promise<FileArchivalResult> {
    const now = this.nowSeconds();
    const cutoffArchive = now - config.history.archival.archiveAfterDays * SECONDS_PER_DAY;
    const retentionDays = config.history.archival.retentionDays;
    const cutoffRetention = retentionDays > 0 ? now - retentionDays * SECONDS_PER_DAY : null;

    const result: FileArchivalResult = {
      archivedCount: 0,
      deletedByRetention: 0,
      files: [],
      cutoffArchive,
      cutoffRetention,
      dryRun,
    };

    if (dryRun) {
      for (const filePath of this.listAssetFiles()) {
        try {
          const history = readHistoryFile(filePath);
          result.archivedCount += history.filter((h) => h.timestamp < cutoffArchive).length;
        } catch { /* skip corrupt files */ }
      }
      logger.info(
        `[file-archival dry-run] would archive ${result.archivedCount} total entry(s); ` +
          `retention ${retentionDays > 0 ? `would purge files older than ${retentionDays}d` : 'disabled'}`,
      );
      return result;
    }

    if (!fs.existsSync(this.coldDir)) {
      fs.mkdirSync(this.coldDir, { recursive: true });
    }

    for (const filePath of this.listAssetFiles()) {
      const asset = path.basename(filePath, '.json').replace('history-', '').toUpperCase();
      let history: HistoryEntry[];
      try {
        history = readHistoryFile(filePath);
      } catch {
        continue;
      }

      const archived: HistoryEntry[] = [];
      const active: HistoryEntry[] = [];

      for (const entry of history) {
        if (entry.timestamp < cutoffArchive) {
          archived.push(entry);
        } else {
          active.push(entry);
        }
      }

      if (archived.length > 0) {
        const fileName = `history_${asset}_${cutoffArchive}_${Date.now()}.ndjson.gz`;
        const archivePath = path.join(this.coldDir, fileName);
        await this.writeNdjsonGz(archivePath, archived);
        result.files.push(archivePath);
        result.archivedCount += archived.length;

        writeHistoryFile(filePath, active);
      }
    }

    if (cutoffRetention !== null) {
      result.deletedByRetention = this.purgeColdFiles(cutoffRetention);
    }

    logger.info(
      `File archival pass complete: archived ${result.archivedCount} entry(s) to ${result.files.length} file(s); ` +
        `retention purged ${result.deletedByRetention} cold file(s)`,
    );
    return result;
  }

  /**
   * Delete archive files whose cutoff timestamp (encoded in the filename) is
   * older than the retention cutoff.
   */
  private purgeColdFiles(cutoff: number): number {
    if (!fs.existsSync(this.coldDir)) return 0;
    let deleted = 0;
    for (const entry of fs.readdirSync(this.coldDir)) {
      if (!entry.endsWith('.ndjson.gz')) continue;
      const parts = entry.replace('.ndjson.gz', '').split('_');
      const fileCutoff = parseInt(parts[2], 10);
      if (!isNaN(fileCutoff) && fileCutoff < cutoff) {
        fs.unlinkSync(path.join(this.coldDir, entry));
        deleted++;
      }
    }
    return deleted;
  }

  private async writeNdjsonGz(filePath: string, rows: HistoryEntry[]): Promise<void> {
    const ndjson = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const payload = historyEncryptionEnabled() ? encrypt(ndjson) : ndjson;
    const source = Readable.from([payload]);
    await pipeline(source, createGzip(), createWriteStream(filePath));
  }

  /**
   * Restore archived entries back into their per-asset history files.
   * Pass a specific archive file to restore one, or omit to restore all.
   */
  async restore(file?: string): Promise<number> {
    const targets = file
      ? [path.isAbsolute(file) ? file : path.join(this.coldDir, file)]
      : this.listArchiveFiles();

    let restored = 0;
    for (const target of targets) {
      restored += await this.restoreFile(target);
    }
    logger.info(`Restored ${restored} record(s) from ${targets.length} archive file(s)`);
    return restored;
  }

  listArchiveFiles(): string[] {
    if (!fs.existsSync(this.coldDir)) return [];
    return fs.readdirSync(this.coldDir)
      .filter((f) => f.endsWith('.ndjson.gz'))
      .map((f) => path.join(this.coldDir, f))
      .sort();
  }

  private async restoreFile(filePath: string): Promise<number> {
    const assetMatch = path.basename(filePath).match(/^history_(\w+)_/);
    if (!assetMatch) return 0;
    const asset = assetMatch[1].toLowerCase();

    const historyPath = HISTORY_FILE(asset);
    let current: HistoryEntry[];
    try {
      current = readHistoryFile(historyPath);
    } catch {
      current = [];
    }
    const existing = new Set(
      current.map((h) => `${h.timestamp}:${h.source}`),
    );

    const archive = await this.readArchivePayload(filePath);
    let count = 0;
    for (const line of archive.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed) as HistoryEntry;
      const key = `${entry.timestamp}:${entry.source}`;
      if (!existing.has(key)) {
        current.push(entry);
        existing.add(key);
        count++;
      }
    }

    if (count > 0) {
      current.sort((a, b) => a.timestamp - b.timestamp);
      writeHistoryFile(historyPath, current);
    }
    return count;
  }

  private async readArchivePayload(filePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    const gunzip = createReadStream(filePath).pipe(createGunzip());
    for await (const chunk of gunzip) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const payload = Buffer.concat(chunks).toString('utf-8');
    return isEncrypted(payload) ? decrypt(payload) : payload;
  }

  /** Start the scheduled archival loop (issue #43). */
  start(): void {
    if (!config.history.archival.enabled) return;
    const interval = config.history.archival.intervalMs;
    this.timer = setInterval(() => {
      this.runOnce(false).catch((err) => logger.error('Scheduled file archival failed', err));
    }, interval);
    this.timer.unref?.();
    logger.info(
      `File archival scheduled every ${Math.round(interval / 3600000)}h ` +
        `(archive >${config.history.archival.archiveAfterDays}d, ` +
        `retention ${config.history.archival.retentionDays || 'disabled'})`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
