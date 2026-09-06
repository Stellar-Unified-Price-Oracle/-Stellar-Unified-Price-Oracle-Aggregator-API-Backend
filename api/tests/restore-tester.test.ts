import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';

vi.mock('../src/observability/metrics', () => {
  const registry = { registerMetric: vi.fn() };
  return { register: registry };
});

vi.mock('../src/infrastructure/backup', () => {
  return {
    BackupService: vi.fn(),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  RestoreTester,
  restoreTestTotal,
  restoreTestDurationMs,
  restoreIntegrityFailures,
} from '../src/infrastructure/restore-tester';
import { BackupService, BackupEntry } from '../src/infrastructure/backup';

const execFileAsync = promisify(execFile);

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeBackupService(entries: BackupEntry[] = []) {
  const svc = {
    listBackups: vi.fn().mockReturnValue(entries),
    restore: vi.fn().mockResolvedValue({ success: true, file: 'backup.sql.gz', durationMs: 100 }),
  };
  return svc as unknown as BackupService;
}

function makeEntry(file = '/backups/backup_2024-01-01.sql.gz'): BackupEntry {
  return { file, sizeBytes: 1024, createdAt: new Date(), encrypted: false };
}

function mockExecFile(impl: (...args: any[]) => void) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(impl);
}

function execSucceeds(responses: Record<string, string> = {}) {
  mockExecFile((...args: any[]) => {
    const cb = args[args.length - 1];
    const cmdArgs: string[] = args[1] ?? [];
    const query = cmdArgs.find((a: string) => a.includes('SELECT') || a.includes('CREATE') || a.includes('DROP') || a === '\\l');
    let stdout = '0\n';
    if (query) {
      for (const [key, val] of Object.entries(responses)) {
        if (query.includes(key)) {
          stdout = val;
          break;
        }
      }
    }
    cb(null, { stdout, stderr: '' });
  });
}

describe('RestoreTester', () => {
  let logger: ReturnType<typeof makeLogger>;
  let dataDir: string;

  beforeEach(async () => {
    logger = makeLogger();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-test-data-'));

    vi.spyOn(restoreTestTotal, 'inc').mockImplementation(() => restoreTestTotal);
    vi.spyOn(restoreTestDurationMs, 'set').mockImplementation(() => restoreTestDurationMs);
    vi.spyOn(restoreIntegrityFailures, 'inc').mockImplementation(() => restoreIntegrityFailures);
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('testConfigRestore', () => {
    it('passes when all config files exist and are valid', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfg-'));
      try {
        const envExample = path.join(tmpDir, '.env.example');
        await fsp.writeFile(
          envExample,
          'DATABASE_URL=\nAPI_PORT=3000\nWATCHED_ASSETS=XLM\nSOROBAN_RPC_URL=\n',
        );
        const costModel = path.join(tmpDir, 'cost-model.json');
        await fsp.writeFile(costModel, '{"currency":"USD"}');

        const svc = makeBackupService();
        const tester = new RestoreTester(
          'postgresql://localhost/test',
          svc,
          logger,
          {
            configFiles: [envExample, costModel],
            dataDir,
          },
        );

        const result = await tester.testConfigRestore();

        expect(result.success).toBe(true);
        expect(result.type).toBe('config');
        expect(result.filesVerified).toHaveLength(2);
        expect(restoreTestTotal.inc).toHaveBeenCalledWith({ type: 'config', result: 'success' });
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails when a config file is missing', async () => {
      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        {
          configFiles: ['/nonexistent/path/.env.example'],
          dataDir,
        },
      );

      const result = await tester.testConfigRestore();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/);
      expect(restoreIntegrityFailures.inc).toHaveBeenCalledWith({ type: 'config' });
      expect(logger.error).toHaveBeenCalled();
    });

    it('fails when a JSON config file contains invalid JSON', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfg-bad-'));
      try {
        const badJson = path.join(tmpDir, 'bad.json');
        await fsp.writeFile(badJson, '{not valid json');

        const svc = makeBackupService();
        const tester = new RestoreTester(
          'postgresql://localhost/test',
          svc,
          logger,
          { configFiles: [badJson], dataDir },
        );

        const result = await tester.testConfigRestore();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not valid JSON/);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails when .env.example is missing a required key', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfg-env-'));
      try {
        const envFile = path.join(tmpDir, '.env.example');
        await fsp.writeFile(envFile, 'ONLY_ONE_KEY=value\n');

        const svc = makeBackupService();
        const tester = new RestoreTester(
          'postgresql://localhost/test',
          svc,
          logger,
          { configFiles: [envFile], dataDir },
        );

        const result = await tester.testConfigRestore();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/missing required key/);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails when a config file is empty', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfg-empty-'));
      try {
        const emptyFile = path.join(tmpDir, 'empty.json');
        await fsp.writeFile(emptyFile, '');

        const svc = makeBackupService();
        const tester = new RestoreTester(
          'postgresql://localhost/test',
          svc,
          logger,
          { configFiles: [emptyFile], dataDir },
        );

        const result = await tester.testConfigRestore();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/empty/);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('testHistoryFilesRestore', () => {
    it('passes when all history files are valid JSON arrays with required fields', async () => {
      const history = [
        { price: '0.12', decimals: 7, source: 'chainlink', timestamp: 1700000000 },
        { price: '0.13', decimals: 7, source: 'redstone', timestamp: 1700000060 },
      ];
      await fsp.writeFile(
        path.join(dataDir, 'history-xlm.json'),
        JSON.stringify(history),
      );

      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(true);
      expect(result.type).toBe('history_files');
      expect(result.filesVerified).toBe(1);
      expect(restoreTestTotal.inc).toHaveBeenCalledWith({ type: 'history_files', result: 'success' });
    });

    it('passes with zero files when data directory is empty', async () => {
      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(true);
      expect(result.filesVerified).toBe(0);
    });

    it('succeeds (skipped) when data directory does not exist', async () => {
      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir: '/nonexistent/data/dir' },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(true);
      expect(result.filesVerified).toBe(0);
    });

    it('fails when a history file contains invalid JSON', async () => {
      await fsp.writeFile(path.join(dataDir, 'history-btc.json'), '{invalid json}');

      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not valid JSON/);
      expect(restoreIntegrityFailures.inc).toHaveBeenCalledWith({ type: 'history_files' });
      expect(logger.error).toHaveBeenCalled();
    });

    it('fails when a history file is not an array', async () => {
      await fsp.writeFile(
        path.join(dataDir, 'history-eth.json'),
        JSON.stringify({ price: '3500', timestamp: 1700000000 }),
      );

      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/JSON array/);
    });

    it('fails when a history entry is missing a required field', async () => {
      const badHistory = [{ price: '0.12', decimals: 7, source: 'chainlink' }];
      await fsp.writeFile(
        path.join(dataDir, 'history-xlm.json'),
        JSON.stringify(badHistory),
      );

      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/missing required field "timestamp"/);
    });

    it('fails when a history entry has an invalid price', async () => {
      const badHistory = [
        { price: '-0.01', decimals: 7, source: 'chainlink', timestamp: 1700000000 },
      ];
      await fsp.writeFile(
        path.join(dataDir, 'history-xlm.json'),
        JSON.stringify(badHistory),
      );

      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid price/);
    });

    it('verifies multiple history files', async () => {
      const history = [
        { price: '0.12', decimals: 7, source: 'chainlink', timestamp: 1700000000 },
      ];
      for (const asset of ['xlm', 'btc', 'eth']) {
        await fsp.writeFile(
          path.join(dataDir, `history-${asset}.json`),
          JSON.stringify(history),
        );
      }
      await fsp.writeFile(path.join(dataDir, 'other-file.txt'), 'ignored');

      const svc = makeBackupService();
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testHistoryFilesRestore();

      expect(result.success).toBe(true);
      expect(result.filesVerified).toBe(3);
    });
  });

  describe('testTimescaleRestore', () => {
    it('fails immediately when no backups are available', async () => {
      const svc = makeBackupService([]);
      const tester = new RestoreTester(
        'postgresql://localhost/test',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testTimescaleRestore();

      expect(result.success).toBe(false);
      expect(result.type).toBe('timescaledb');
      expect(result.error).toMatch(/No backups/);
      expect(restoreIntegrityFailures.inc).toHaveBeenCalledWith({ type: 'timescaledb' });
    });

    it('fails when backup restore returns failure', async () => {
      const svc = makeBackupService([makeEntry()]);
      svc.restore = vi.fn().mockResolvedValue({
        success: false,
        error: 'pg_restore error',
        file: '/backups/backup.sql.gz',
        durationMs: 50,
      });

      execSucceeds({
        'CREATE DATABASE': '',
        '\\l': '',
        'DROP DATABASE': '',
      });

      const tester = new RestoreTester(
        'postgresql://localhost/oracle',
        svc,
        logger,
        { dataDir },
      );

      const result = await tester.testTimescaleRestore();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Restore failed/);
    });

    it('emits success metrics when all DB assertions pass', async () => {
      const svc = makeBackupService([makeEntry()]);

      execSucceeds({
        'COUNT(*)': '42\n',
        'DISTINCT asset': 'BTC\nXLM\nETH\n',
        'price AS NUMERIC': '0\n',
        'hypertables': '1\n',
        'CREATE DATABASE': '',
        '\\l': '',
        'DROP DATABASE': '',
        'dupes': '0\n',
      });

      const tester = new RestoreTester(
        'postgresql://localhost/oracle',
        svc,
        logger,
        { dataDir },
      );

      vi.spyOn(tester as any, 'createTempDb').mockResolvedValue('restore_test_123');
      vi.spyOn(tester as any, 'dropTempDb').mockResolvedValue(undefined);
      vi.spyOn(tester as any, 'restoreToTempDb').mockResolvedValue(undefined);
      vi.spyOn(tester as any, 'assertTimescaleIntegrity').mockResolvedValue({
        rowCount: 42,
        assetsPresent: ['BTC', 'ETH', 'XLM'],
      });

      const result = await tester.testTimescaleRestore();

      expect(result.success).toBe(true);
      expect(result.rowCount).toBe(42);
      expect(result.assetsPresent).toEqual(['BTC', 'ETH', 'XLM']);
      expect(restoreTestTotal.inc).toHaveBeenCalledWith({ type: 'timescaledb', result: 'success' });
    });
  });

  describe('runAll', () => {
    it('returns results for all three test types', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'runall-cfg-'));
      try {
        const envExample = path.join(tmpDir, '.env.example');
        await fsp.writeFile(
          envExample,
          'DATABASE_URL=\nAPI_PORT=3000\nWATCHED_ASSETS=XLM\nSOROBAN_RPC_URL=\n',
        );

        const svc = makeBackupService([]);
        const tester = new RestoreTester(
          'postgresql://localhost/oracle',
          svc,
          logger,
          {
            dataDir,
            configFiles: [envExample],
          },
        );

        vi.spyOn(tester, 'testTimescaleRestore').mockResolvedValue({
          type: 'timescaledb',
          success: false,
          durationMs: 10,
          error: 'No backups',
        });
        vi.spyOn(tester, 'testHistoryFilesRestore').mockResolvedValue({
          type: 'history_files',
          success: true,
          durationMs: 5,
          filesVerified: 0,
        });
        vi.spyOn(tester, 'testConfigRestore').mockResolvedValue({
          type: 'config',
          success: true,
          durationMs: 2,
          filesVerified: [envExample],
        });

        const results = await tester.runAll();

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.type)).toEqual(
          expect.arrayContaining(['timescaledb', 'history_files', 'config']),
        );
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('captures errors from individual test methods without crashing runAll', async () => {
      const svc = makeBackupService([]);
      const tester = new RestoreTester(
        'postgresql://localhost/oracle',
        svc,
        logger,
        { dataDir },
      );

      vi.spyOn(tester, 'testTimescaleRestore').mockRejectedValue(new Error('unexpected crash'));
      vi.spyOn(tester, 'testHistoryFilesRestore').mockResolvedValue({
        type: 'history_files',
        success: true,
        durationMs: 1,
        filesVerified: 0,
      });
      vi.spyOn(tester, 'testConfigRestore').mockResolvedValue({
        type: 'config',
        success: true,
        durationMs: 1,
        filesVerified: [],
      });

      const results = await tester.runAll();

      expect(results).toHaveLength(3);
      const failed = results.find((r) => !r.success);
      expect(failed).toBeDefined();
      expect(failed?.error).toMatch(/unexpected crash/);
    });
  });
});
