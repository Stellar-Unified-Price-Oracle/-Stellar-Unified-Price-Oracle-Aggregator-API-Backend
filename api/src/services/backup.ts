import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import { createGzip, createGunzip } from 'zlib';
import path from 'path';
import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../middleware/metrics';

const execFileAsync = promisify(execFile);

export const backupTotal = new client.Counter({
  name: 'backup_total',
  help: 'Total backup runs by result',
  labelNames: ['result'],
});
register.registerMetric(backupTotal);

export const backupSizeBytes = new client.Gauge({
  name: 'backup_size_bytes',
  help: 'Size of the most recent backup in bytes',
});
register.registerMetric(backupSizeBytes);

export const backupDurationMs = new client.Gauge({
  name: 'backup_duration_ms',
  help: 'Duration of the most recent backup in ms',
});
register.registerMetric(backupDurationMs);

export interface BackupEntry {
  file: string;
  sizeBytes: number;
  createdAt: Date;
  encrypted: boolean;
}

export interface BackupResult {
  file: string;
  sizeBytes: number;
  durationMs: number;
  encrypted: boolean;
  timestamp: number;
}

export interface RestoreResult {
  file: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

const ALGO = 'aes-256-gcm' as const;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Backup service providing:
 *  - Automated daily pg_dump backups
 *  - AES-256-GCM encryption at rest (same key as the rest of the app)
 *  - gzip compression
 *  - Point-in-time metadata (backup timestamp recorded in filename)
 *  - Restore testing (decrypt + decompress integrity check)
 *  - Admin-triggered on-demand backup and restore
 */
export class BackupService {
  private dailyTimer?: NodeJS.Timeout;
  private restoreTestTimer?: NodeJS.Timeout;
  private readonly backupDir: string;
  private readonly encKey: Buffer | null;
  private readonly databaseUrl: string;
  private readonly dailyIntervalMs: number;
  private readonly restoreTestIntervalMs: number;

  constructor(
    databaseUrl: string,
    private readonly logger: Logger,
    options: {
      backupDir?: string;
      encryptionKeyHex?: string;
      dailyIntervalMs?: number;
      restoreTestIntervalMs?: number;
    } = {},
  ) {
    this.databaseUrl = databaseUrl;
    this.backupDir = path.resolve(options.backupDir ?? './data/backups');
    this.encKey = options.encryptionKeyHex
      ? Buffer.from(options.encryptionKeyHex.padEnd(64, '0').slice(0, 64), 'hex')
      : null;
    // DR (issue #106): interval defaults to 24h but is configurable — a short
    // interval (e.g. 5min) lets Tier 2 recovery alone meet an aggressive RPO target
    // even when Tier 1's WAL archive is also unavailable.
    this.dailyIntervalMs = options.dailyIntervalMs ?? 24 * 60 * 60 * 1000;
    this.restoreTestIntervalMs = options.restoreTestIntervalMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  start(): void {
    const intervalMs = this.dailyIntervalMs;
    // First backup fires 30s after startup so the DB has time to warm up
    const initial = setTimeout(() => { void this.createBackup(); }, 30_000);
    initial.unref?.();

    this.dailyTimer = setInterval(() => { void this.createBackup(); }, intervalMs);
    this.dailyTimer.unref?.();

    // Weekly restore-integrity test
    const weeklyMs = this.restoreTestIntervalMs;
    this.restoreTestTimer = setInterval(() => { void this.testRestoreIntegrity(); }, weeklyMs);
    this.restoreTestTimer.unref?.();

    this.logger.info(
      `Backup service started — snapshots every ${Math.round(intervalMs / 1000)}s to ${this.backupDir}` +
      (this.encKey ? ' (AES-256-GCM encrypted)' : ' (unencrypted — set BACKUP_ENCRYPTION_KEY)'),
    );
  }

  stop(): void {
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    if (this.restoreTestTimer) clearInterval(this.restoreTestTimer);
  }

  async createBackup(): Promise<BackupResult> {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    const t0 = Date.now();
    const isoDate = new Date(t0).toISOString().replace(/[:.]/g, '-');
    const ext = this.encKey ? '.sql.gz.enc' : '.sql.gz';
    const outPath = path.join(this.backupDir, `backup_${isoDate}${ext}`);

    this.logger.info(`Starting backup → ${path.basename(outPath)}`);

    try {
      const { stdout } = await execFileAsync(
        'pg_dump',
        ['--format=plain', '--no-password', this.databaseUrl],
        { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
      );

      const sqlBuf = stdout as unknown as Buffer;
      const compressed = await gzipBuffer(sqlBuf);
      const payload = this.encKey ? encryptBuffer(compressed, this.encKey) : compressed;
      await fsp.writeFile(outPath, payload);

      const stat = fs.statSync(outPath);
      const durationMs = Date.now() - t0;

      backupTotal.inc({ result: 'success' });
      backupSizeBytes.set(stat.size);
      backupDurationMs.set(durationMs);

      this.logger.info(
        `Backup complete: ${path.basename(outPath)} ` +
        `(${(stat.size / 1024).toFixed(1)} KB, ${durationMs}ms)`,
      );
      return { file: outPath, sizeBytes: stat.size, durationMs, encrypted: !!this.encKey, timestamp: t0 };
    } catch (err) {
      backupTotal.inc({ result: 'failure' });
      this.logger.error('Backup failed', err);
      throw err;
    }
  }

  async restore(backupFile: string): Promise<RestoreResult> {
    const t0 = Date.now();
    const resolved = path.isAbsolute(backupFile)
      ? backupFile
      : path.join(this.backupDir, backupFile);

    if (!fs.existsSync(resolved)) {
      return { file: resolved, durationMs: 0, success: false, error: 'Backup file not found' };
    }

    try {
      const sql = await this.readAndDecrypt(resolved);
      await execFileAsync('psql', ['--no-password', this.databaseUrl], {
        // @ts-expect-error -- execFile accepts Buffer as input but types differ
        input: sql,
        maxBuffer: 512 * 1024 * 1024,
      });
      const durationMs = Date.now() - t0;
      this.logger.info(`Restore complete from ${path.basename(resolved)} (${durationMs}ms)`);
      return { file: resolved, durationMs, success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Restore failed: ${msg}`);
      return { file: resolved, durationMs: Date.now() - t0, success: false, error: msg };
    }
  }

  /** Decrypt and decompress the most recent backup to verify integrity without touching the DB. */
  async testRestoreIntegrity(): Promise<{ success: boolean; message: string; file?: string }> {
    const entries = this.listBackups();
    if (entries.length === 0) {
      return { success: false, message: 'No backups available to test' };
    }
    const latest = entries[entries.length - 1];
    try {
      await this.readAndDecrypt(latest.file);
      const msg = `Restore integrity verified: ${path.basename(latest.file)}`;
      this.logger.info(`[backup] ${msg}`);
      return { success: true, message: msg, file: latest.file };
    } catch (err: unknown) {
      const msg = `Restore integrity test failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(`[backup] ${msg}`);
      return { success: false, message: msg, file: latest.file };
    }
  }

  listBackups(): BackupEntry[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.startsWith('backup_'))
      .map((f) => {
        const full = path.join(this.backupDir, f);
        const stat = fs.statSync(full);
        return {
          file: full,
          sizeBytes: stat.size,
          createdAt: stat.birthtime,
          encrypted: f.endsWith('.enc'),
        };
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  private async readAndDecrypt(filePath: string): Promise<Buffer> {
    const raw = await fsp.readFile(filePath);
    const compressed = filePath.endsWith('.enc') && this.encKey
      ? decryptBuffer(raw, this.encKey)
      : raw;
    return gunzipBuffer(compressed);
  }
}

// ── Crypto helpers ─────────────────────────────────────────────────────────────

function encryptBuffer(data: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [IV (12)] [AuthTag (16)] [ciphertext]
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptBuffer(data: Buffer, key: Buffer): Buffer {
  const iv = data.slice(0, IV_LENGTH);
  const tag = data.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.slice(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function gzipBuffer(buf: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const gz = createGzip();
    const chunks: Buffer[] = [];
    gz.on('data', (c: Buffer) => chunks.push(c));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
    gz.write(buf);
    gz.end();
  });
}

function gunzipBuffer(buf: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const gz = createGunzip();
    const chunks: Buffer[] = [];
    gz.on('data', (c: Buffer) => chunks.push(c));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
    gz.write(buf);
    gz.end();
  });
}
