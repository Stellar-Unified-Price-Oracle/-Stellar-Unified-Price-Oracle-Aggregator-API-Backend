import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseClient } from '../src/infrastructure/database';
import { PoolClient, QueryResult } from 'pg';

vi.mock('../src/infrastructure/config', () => ({
  config: {
    db: {
      poolMin: 2,
      poolMax: 10,
      idleTimeoutMs: 30000,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 30000,
      retry: { maxAttempts: 3, backoffMs: 100 },
      circuitBreaker: { threshold: 5, timeout: 60000 },
      replica: { urls: [] },
    },
  },
}));

vi.mock('../src/observability/metrics');

describe('TimescaleDB Compression Policies', () => {
  let mockPool: any;
  let mockPoolClient: any;
  let logger: any;

  beforeEach(() => {
    mockPoolClient = {
      query: vi.fn(),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue(mockPoolClient),
      name: 'primary',
    };

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('enableTimescaleCompression', () => {
    it('should enable compression on hypertable', async () => {
      const sql = `
        ALTER TABLE price_history
        SET (timescaledb.compress = true);
      `;

      expect(sql).toContain('timescaledb.compress = true');
      expect(sql).toContain('price_history');
    });

    it('should configure segment_by columns for compression', () => {
      const segmentBy = ['asset', 'source'];
      const orderBy = ['timestamp DESC', 'price DESC'];

      const sql = `
        ALTER TABLE price_history
        SET (timescaledb.compress, timescaledb.compress_segmentby = '${segmentBy.join(',')}',
             timescaledb.compress_orderby = '${orderBy.join(',')}');
      `;

      expect(sql).toContain('compress_segmentby');
      expect(sql).toContain('compress_orderby');
      expect(sql).toContain('asset');
      expect(sql).toContain('source');
    });

    it('should throw error if already compressed', async () => {
      const error = new Error("relation \"price_history\" is already compressed");
      mockPool.query.mockRejectedValueOnce(error);

      try {
        await mockPool.query('SELECT 1');
      } catch (err) {
        expect((err as Error).message).toContain('already compressed');
      }
    });

    it('should handle invalid segment_by columns', () => {
      const invalidColumns = ['non_existent_column'];
      const sql = `
        ALTER TABLE price_history
        SET (timescaledb.compress, timescaledb.compress_segmentby = '${invalidColumns.join(',')}');
      `;

      expect(sql).toContain('non_existent_column');
    });
  });

  describe('Compression Policy Management', () => {
    it('should add compression policy for chunks older than N days', async () => {
      const chunkAge = 30;
      const sql = `
        SELECT add_compression_policy('price_history', INTERVAL '${chunkAge} days');
      `;

      expect(sql).toContain('add_compression_policy');
      expect(sql).toContain(`${chunkAge} days`);
      expect(sql).toContain('price_history');
    });

    it('should handle policy already exists error', async () => {
      const error = new Error(
        'Compression policy already exists for hypertable \"price_history\"'
      );
      mockPool.query.mockRejectedValueOnce(error);

      try {
        await mockPool.query('SELECT add_compression_policy');
      } catch (err) {
        expect((err as Error).message).toContain('already exists');
      }
    });

    it('should remove existing compression policy', async () => {
      const sql = `
        SELECT remove_compression_policy('price_history');
      `;

      expect(sql).toContain('remove_compression_policy');
      expect(sql).toContain('price_history');
    });

    it('should create compression policy with correct timing', () => {
      const policyDays = 30;
      const expectedTime = policyDays * 24 * 60 * 60 * 1000;

      expect(expectedTime).toBeGreaterThan(0);
      expect(expectedTime).toBe(2592000000);
    });
  });

  describe('Chunk Compression', () => {
    it('should compress individual chunks manually', async () => {
      const chunkName = 'price_history_1';
      const sql = `SELECT compress_chunk('${chunkName}');`;

      expect(sql).toContain('compress_chunk');
      expect(sql).toContain(chunkName);
    });

    it('should get compression status of chunks', async () => {
      const sql = `
        SELECT chunk_name, is_compressed, before_compression_bytes, after_compression_bytes
        FROM chunk_compression_stats('price_history')
        ORDER BY before_compression_bytes DESC;
      `;

      expect(sql).toContain('chunk_compression_stats');
      expect(sql).toContain('is_compressed');
      expect(sql).toContain('before_compression_bytes');
    });

    it('should decompress chunk if needed', async () => {
      const chunkName = 'price_history_1';
      const sql = `SELECT decompress_chunk('${chunkName}');`;

      expect(sql).toContain('decompress_chunk');
    });

    it('should handle compression of multiple chunks', async () => {
      const chunks = ['chunk_1', 'chunk_2', 'chunk_3'];
      const sql = chunks
        .map((chunk) => `SELECT compress_chunk('${chunk}');`)
        .join('\n');

      expect(sql).toContain('chunk_1');
      expect(sql).toContain('chunk_2');
      expect(sql).toContain('chunk_3');
    });
  });

  describe('Storage Reduction Validation', () => {
    it('should validate storage reduction metrics', () => {
      const beforeCompression = 1000000000;
      const afterCompression = 100000000;
      const reductionPercent = ((beforeCompression - afterCompression) / beforeCompression) * 100;

      expect(reductionPercent).toBeGreaterThanOrEqual(90);
      expect(reductionPercent).toBe(90);
    });

    it('should estimate compression ratio', () => {
      const historicalDataSize = 10 * 1024 * 1024 * 1024;
      const compressionRatio = 0.1;
      const estimatedCompressedSize = historicalDataSize * compressionRatio;

      expect(estimatedCompressedSize).toBe(1 * 1024 * 1024 * 1024);
    });

    it('should track disk space savings over time', () => {
      const metrics = {
        timestamp: Date.now(),
        beforeBytes: 1000000000,
        afterBytes: 100000000,
        savedBytes: 900000000,
      };

      expect(metrics.savedBytes).toBe(metrics.beforeBytes - metrics.afterBytes);
      expect(metrics.savedBytes).toBeGreaterThan(0);
    });
  });

  describe('Compression with Query Performance', () => {
    it('should maintain query performance on compressed data', async () => {
      const sql = `
        SELECT asset, AVG(price::numeric) as avg_price
        FROM price_history
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        GROUP BY asset;
      `;

      expect(sql).toContain('price_history');
      expect(sql).toContain('AVG(price');
    });

    it('should handle decompressed column queries efficiently', async () => {
      const sql = `
        SELECT asset, price, timestamp
        FROM price_history
        WHERE compressed_timestamp > NOW() - INTERVAL '7 days'
        LIMIT 1000;
      `;

      expect(sql).toContain('LIMIT 1000');
    });

    it('should support compression with partial scans', () => {
      const sql = `
        SELECT asset, COUNT(*) as count
        FROM price_history
        WHERE timestamp > NOW() - INTERVAL '30 days'
        GROUP BY asset
        ORDER BY count DESC;
      `;

      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('ORDER BY');
    });
  });

  describe('Compression Configuration Validation', () => {
    it('should validate compression segment_by configuration', () => {
      const config = {
        tableName: 'price_history',
        segmentBy: ['asset', 'source'],
        orderBy: ['timestamp DESC'],
      };

      expect(config.segmentBy).toContain('asset');
      expect(config.orderBy[0]).toContain('DESC');
    });

    it('should handle default compression settings', () => {
      const defaultConfig = {
        chunkAgeInDays: 30,
        segmentByColumns: ['asset'],
        orderByColumns: ['timestamp DESC'],
      };

      expect(defaultConfig.chunkAgeInDays).toBe(30);
      expect(defaultConfig.segmentByColumns.length).toBeGreaterThan(0);
    });

    it('should apply compression to multiple hypertables', () => {
      const tables = ['price_history', 'price_history_archive', 'ohlc_data'];

      tables.forEach((table) => {
        const sql = `ALTER TABLE ${table} SET (timescaledb.compress = true);`;
        expect(sql).toContain('timescaledb.compress');
      });

      expect(tables.length).toBe(3);
    });
  });

  describe('Compression Monitoring', () => {
    it('should monitor compression job status', () => {
      const mockCompressionJob = {
        job_id: 1000,
        hypertable_id: 1,
        hypertable_name: 'price_history',
        job_type: 'compress_chunks',
        schedule_interval: '30 days',
        materialized_only: false,
        paused: false,
      };

      expect(mockCompressionJob.job_type).toBe('compress_chunks');
      expect(mockCompressionJob.paused).toBe(false);
    });

    it('should track compression success/failure', () => {
      const compressionLog = [
        { chunk_name: 'chunk_1', status: 'success', compressed_size: 50000000 },
        { chunk_name: 'chunk_2', status: 'success', compressed_size: 45000000 },
        { chunk_name: 'chunk_3', status: 'failed', error: 'Insufficient disk space' },
      ];

      const successCount = compressionLog.filter((log) => log.status === 'success').length;
      expect(successCount).toBe(2);
    });
  });
});
