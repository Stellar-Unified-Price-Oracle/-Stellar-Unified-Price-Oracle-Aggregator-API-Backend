import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../observability/metrics';
import { BackupService, BackupEntry } from './backup';

const execFileAsync = promisify(execFile);

export const restoreTestTotal = new client.Counter({
  name: 'restore_test_total',
  help: 'Total restore test runs by type and result',
  labelNames: ['type', 'result'],
});
register.registerMetric(restoreTestTotal);

export const restoreTestDurationMs = new client.Gauge({
  name: 'restore_test_duration_ms',
  help: 'Duration of the most recent restore test in ms by type',
  labelNames: ['type'],
});
register.registerMetric(restoreTestDurationMs);

export const restoreIntegrityFailures = new client.Counter({
  name: 'restore_integrity_failures',
  help: 'Total restore integrity assertion failures by type',
  labelNames: ['type'],
});
register.registerMetric(restoreIntegrityFailures);

export interface TimescaleRestoreResult {
  type: 'timescaledb';
  success: boolean;
  durationMs: number;
  rowCount?: number;
  assetsPresent?: string[];
  error?: string;
}

export interface HistoryFilesRestoreResult {
  type: 'history_files';
  success: boolean;
  durationMs: number;
  filesVerified?: number;
  error?: string;
}

export interface ConfigRestoreResult {
  type: 'config';
  success: boolean;
  durationMs: number;
  filesVerified?: string[];
  error?: string;
}

export type RestoreTestResult =
  | TimescaleRestoreResult
  | HistoryFilesRestoreResult
  | ConfigRestoreResult;

export interface RestoreTesterOptions {
  tempDbName?: string;
  dataDir?: string;
  configFiles?: string[];
  watchedAssets?: string[];
}

const REQUIRED_HISTORY_FIELDS = ['price', 'decimals', 'source', 'timestamp'] as const;

const DEFAULT_CONFIG_FILES = ['.env.example', 'config/cost-model.json'];

export class RestoreTester {
  private readonly dataDir: string;
  private readonly configFiles: string[];
  private readonly tempDbName: string;

  constructor(
    private readonly databaseUrl: string,
    private readonly backupService: BackupService,
    private readonly logger: Logger,
    options: RestoreTesterOptions = {},
  ) {
    this.dataDir = options.dataDir ?? path.resolve('./data');
    this.configFiles = options.configFiles ?? DEFAULT_CONFIG_FILES;
    this.tempDbName = options.tempDbName ?? `restore_test_${Date.now()}`;
  }

  async runAll(): Promise<RestoreTestResult[]> {
    const results = await Promise.allSettled([
      this.testTimescaleRestore(),
      this.testHistoryFilesRestore(),
      this.testConfigRestore(),
    ]);

    return results.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return {
        type: 'timescaledb' as const,
        success: false,
        durationMs: 0,
        error: err,
      };
    });
  }

  async testTimescaleRestore(): Promise<TimescaleRestoreResult> {
    const t0 = Date.now();
    const type = 'timescaledb';

    const entries = this.backupService.listBackups();
    if (entries.length === 0) {
      return this.failTimescale(t0, 'No backups available for restore test');
    }

    const latest = entries[entries.length - 1] as BackupEntry;
    let tempDb: string | null = null;

    try {
      tempDb = await this.createTempDb();
      await this.restoreToTempDb(latest.file, tempDb);
      const assertions = await this.assertTimescaleIntegrity(tempDb);
      const durationMs = Date.now() - t0;

      restoreTestTotal.inc({ type, result: 'success' });
      restoreTestDurationMs.set({ type }, durationMs);

      this.logger.info(`[restore-tester] TimescaleDB restore test passed in ${durationMs}ms`, {
        rowCount: assertions.rowCount,
        assetsPresent: assertions.assetsPresent,
      });

      return {
        type,
        success: true,
        durationMs,
        rowCount: assertions.rowCount,
        assetsPresent: assertions.assetsPresent,
      };
    } catch (err: unknown) {
      return this.failTimescale(t0, err instanceof Error ? err.message : String(err));
    } finally {
      if (tempDb) await this.dropTempDb(tempDb).catch(() => undefined);
    }
  }

  async testHistoryFilesRestore(): Promise<HistoryFilesRestoreResult> {
    const t0 = Date.now();
    const type = 'history_files';

    let tempDir: string | null = null;

    try {
      tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-history-'));

      if (!fs.existsSync(this.dataDir)) {
        const durationMs = Date.now() - t0;
        restoreTestTotal.inc({ type, result: 'skipped' });
        restoreTestDurationMs.set({ type }, durationMs);
        this.logger.info('[restore-tester] History files restore test skipped — no data directory');
        return { type, success: true, durationMs, filesVerified: 0 };
      }

      const historyFiles = fs
        .readdirSync(this.dataDir)
        .filter((f) => f.startsWith('history-') && f.endsWith('.json'));

      let verified = 0;
      for (const file of historyFiles) {
        const src = path.join(this.dataDir, file);
        const dest = path.join(tempDir, file);
        await fsp.copyFile(src, dest);
        await this.assertHistoryFileIntegrity(dest, file);
        verified++;
      }

      const durationMs = Date.now() - t0;
      restoreTestTotal.inc({ type, result: 'success' });
      restoreTestDurationMs.set({ type }, durationMs);

      this.logger.info(`[restore-tester] History files restore test passed — ${verified} files verified`);

      return { type, success: true, durationMs, filesVerified: verified };
    } catch (err: unknown) {
      return this.failHistoryFiles(t0, err instanceof Error ? err.message : String(err));
    } finally {
      if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async testConfigRestore(): Promise<ConfigRestoreResult> {
    const t0 = Date.now();
    const type = 'config';

    try {
      const verified: string[] = [];
      const projectRoot = path.resolve(__dirname, '../../../../');

      for (const relPath of this.configFiles) {
        const fullPath = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
        await this.assertConfigFileIntegrity(fullPath, relPath);
        verified.push(relPath);
      }

      const durationMs = Date.now() - t0;
      restoreTestTotal.inc({ type, result: 'success' });
      restoreTestDurationMs.set({ type }, durationMs);

      this.logger.info(`[restore-tester] Config restore test passed — verified: ${verified.join(', ')}`);

      return { type, success: true, durationMs, filesVerified: verified };
    } catch (err: unknown) {
      return this.failConfig(t0, err instanceof Error ? err.message : String(err));
    }
  }

  private async createTempDb(): Promise<string> {
    const adminUrl = this.databaseUrl.replace(/\/[^/]+$/, '/postgres');
    await execFileAsync('psql', [adminUrl, '-c', `CREATE DATABASE "${this.tempDbName}"`]);
    return this.tempDbName;
  }

  private async dropTempDb(name: string): Promise<void> {
    const adminUrl = this.databaseUrl.replace(/\/[^/]+$/, '/postgres');
    await execFileAsync('psql', [
      adminUrl,
      '-c',
      `DROP DATABASE IF EXISTS "${name}"`,
    ]);
  }

  private async restoreToTempDb(backupFile: string, dbName: string): Promise<void> {
    const tempUrl = this.databaseUrl.replace(/\/[^/]+$/, `/${dbName}`);
    const result = await this.backupService.restore(backupFile);
    if (!result.success) {
      throw new Error(`Restore failed: ${result.error}`);
    }
    const restoreResult = await execFileAsync('psql', [
      tempUrl,
      '-c',
      '\\l',
    ]).catch(() => null);
    if (!restoreResult) {
      throw new Error(`Could not connect to temp database ${dbName}`);
    }
  }

  private async assertTimescaleIntegrity(
    dbName: string,
  ): Promise<{ rowCount: number; assetsPresent: string[] }> {
    const tempUrl = this.databaseUrl.replace(/\/[^/]+$/, `/${dbName}`);

    const rowResult = await execFileAsync('psql', [
      tempUrl,
      '--tuples-only',
      '--no-align',
      '-c',
      'SELECT COUNT(*) FROM price_history',
    ]);
    const rowCount = parseInt(rowResult.stdout.trim(), 10);
    if (isNaN(rowCount) || rowCount < 0) {
      throw new Error('Row count assertion failed — could not read price_history table');
    }

    const assetResult = await execFileAsync('psql', [
      tempUrl,
      '--tuples-only',
      '--no-align',
      '-c',
      'SELECT DISTINCT asset FROM price_history ORDER BY asset',
    ]);
    const assetsPresent = assetResult.stdout
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean);

    const priceResult = await execFileAsync('psql', [
      tempUrl,
      '--tuples-only',
      '--no-align',
      '-c',
      `SELECT COUNT(*) FROM price_history WHERE CAST(price AS NUMERIC) <= 0`,
    ]);
    const invalidPrices = parseInt(priceResult.stdout.trim(), 10);
    if (invalidPrices > 0) {
      throw new Error(`Price validity assertion failed — ${invalidPrices} rows with price <= 0`);
    }

    const dupResult = await execFileAsync('psql', [
      tempUrl,
      '--tuples-only',
      '--no-align',
      '-c',
      `SELECT COUNT(*) FROM (
        SELECT asset, source, timestamp, COUNT(*) AS cnt
        FROM price_history
        GROUP BY asset, source, timestamp
        HAVING COUNT(*) > 1
      ) dupes`,
    ]);
    const duplicates = parseInt(dupResult.stdout.trim(), 10);
    if (duplicates > 0) {
      throw new Error(`Duplicate assertion failed — ${duplicates} duplicate (asset, source, timestamp) combinations`);
    }

    const hypertableResult = await execFileAsync('psql', [
      tempUrl,
      '--tuples-only',
      '--no-align',
      '-c',
      `SELECT COUNT(*) FROM timescaledb_information.hypertables
       WHERE hypertable_name = 'price_history'`,
    ]).catch(() => ({ stdout: '0' }));

    const hypertableCount = parseInt(hypertableResult.stdout.trim(), 10);
    if (hypertableCount === 0) {
      this.logger.warn('[restore-tester] Hypertable not found — restore DB may be plain Postgres');
    }

    return { rowCount, assetsPresent };
  }

  private async assertHistoryFileIntegrity(filePath: string, label: string): Promise<void> {
    const raw = await fsp.readFile(filePath, 'utf-8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`History file ${label} is not valid JSON`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`History file ${label} must contain a JSON array`);
    }

    for (let i = 0; i < Math.min(parsed.length, 10); i++) {
      const entry = parsed[i] as Record<string, unknown>;
      for (const field of REQUIRED_HISTORY_FIELDS) {
        if (!(field in entry)) {
          throw new Error(
            `History file ${label} entry[${i}] is missing required field "${field}"`,
          );
        }
      }
      const price = parseFloat(String(entry['price']));
      if (isNaN(price) || price <= 0) {
        throw new Error(
          `History file ${label} entry[${i}] has invalid price: ${entry['price']}`,
        );
      }
    }
  }

  private async assertConfigFileIntegrity(fullPath: string, label: string): Promise<void> {
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Config file not found: ${label}`);
    }

    const stat = await fsp.stat(fullPath);
    if (stat.size === 0) {
      throw new Error(`Config file is empty: ${label}`);
    }

    if (label.endsWith('.json')) {
      const raw = await fsp.readFile(fullPath, 'utf-8');
      try {
        JSON.parse(raw);
      } catch {
        throw new Error(`Config file ${label} is not valid JSON`);
      }
    }

    if (label === '.env.example') {
      const raw = await fsp.readFile(fullPath, 'utf-8');
      const requiredKeys = ['DATABASE_URL', 'API_PORT', 'WATCHED_ASSETS', 'SOROBAN_RPC_URL'];
      for (const key of requiredKeys) {
        if (!raw.includes(key)) {
          throw new Error(`.env.example is missing required key: ${key}`);
        }
      }
    }
  }

  private failTimescale(t0: number, errorMsg: string): TimescaleRestoreResult {
    const durationMs = Date.now() - t0;
    restoreTestTotal.inc({ type: 'timescaledb', result: 'failure' });
    restoreTestDurationMs.set({ type: 'timescaledb' }, durationMs);
    restoreIntegrityFailures.inc({ type: 'timescaledb' });
    this.logger.error(`[restore-tester] TimescaleDB restore test FAILED: ${errorMsg}`);
    return { type: 'timescaledb', success: false, durationMs, error: errorMsg };
  }

  private failHistoryFiles(t0: number, errorMsg: string): HistoryFilesRestoreResult {
    const durationMs = Date.now() - t0;
    restoreTestTotal.inc({ type: 'history_files', result: 'failure' });
    restoreTestDurationMs.set({ type: 'history_files' }, durationMs);
    restoreIntegrityFailures.inc({ type: 'history_files' });
    this.logger.error(`[restore-tester] History files restore test FAILED: ${errorMsg}`);
    return { type: 'history_files', success: false, durationMs, error: errorMsg };
  }

  private failConfig(t0: number, errorMsg: string): ConfigRestoreResult {
    const durationMs = Date.now() - t0;
    restoreTestTotal.inc({ type: 'config', result: 'failure' });
    restoreTestDurationMs.set({ type: 'config' }, durationMs);
    restoreIntegrityFailures.inc({ type: 'config' });
    this.logger.error(`[restore-tester] Config restore test FAILED: ${errorMsg}`);
    return { type: 'config', success: false, durationMs, error: errorMsg };
  }
}
