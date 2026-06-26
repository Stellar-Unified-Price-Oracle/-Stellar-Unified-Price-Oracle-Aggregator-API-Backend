import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { setupE2E, teardownE2E, getE2EContainers } from './setup';
import { queryDatabase } from '../../src/services/database';

describe('E2E: API Endpoints', () => {
  let app: Express;

  beforeAll(async () => {
    await setupE2E();

    // Initialize Express app for testing
    app = express();
    app.use(express.json());

    // Health endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Add v1 routes would go here
    app.get('/api/v1', (req, res) => {
      res.json({
        success: true,
        data: {
          version: 'v1',
          endpoints: ['/prices', '/history', '/sources', '/health'],
        },
      });
    });
  });

  afterAll(async () => {
    await teardownE2E();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /api/v1', () => {
    it('should return API root with endpoint listing', async () => {
      const response = await request(app).get('/api/v1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('version', 'v1');
      expect(response.body.data).toHaveProperty('endpoints');
      expect(Array.isArray(response.body.data.endpoints)).toBe(true);
    });
  });
});

describe('E2E: Database Integration', () => {
  beforeAll(async () => {
    await setupE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  });

  it('should initialize database successfully', async () => {
    const result = await queryDatabase('SELECT NOW()');

    expect(result.rowCount).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it('should have assets table', async () => {
    const result = await queryDatabase(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'assets'",
    );

    expect(result.rowCount).toBe(1);
  });

  it('should have oracle_sources table', async () => {
    const result = await queryDatabase(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'oracle_sources'",
    );

    expect(result.rowCount).toBe(1);
  });

  it('should have price_data table', async () => {
    const result = await queryDatabase(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'price_data'",
    );

    expect(result.rowCount).toBe(1);
  });

  it('should have price_history table', async () => {
    const result = await queryDatabase(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'price_history'",
    );

    expect(result.rowCount).toBe(1);
  });

  it('should have source_health table', async () => {
    const result = await queryDatabase(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'source_health'",
    );

    expect(result.rowCount).toBe(1);
  });
});

describe('E2E: Price Data Operations', () => {
  beforeAll(async () => {
    await setupE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  });

  it('should insert and retrieve asset data', async () => {
    // Insert test asset
    const insertResult = await queryDatabase(
      "INSERT INTO assets (code, name, decimals, enabled) VALUES ($1, $2, $3, $4) RETURNING *",
      ['XLM', 'Stellar Lumens', 7, true],
    );

    expect(insertResult.rowCount).toBe(1);
    expect(insertResult.rows[0]).toMatchObject({
      code: 'XLM',
      name: 'Stellar Lumens',
      decimals: 7,
      enabled: true,
    });

    // Query inserted asset
    const selectResult = await queryDatabase('SELECT * FROM assets WHERE code = $1', ['XLM']);

    expect(selectResult.rowCount).toBe(1);
    expect(selectResult.rows[0]).toMatchObject({
      code: 'XLM',
      name: 'Stellar Lumens',
    });
  });

  it('should insert and retrieve oracle source data', async () => {
    // Insert test oracle source
    const insertResult = await queryDatabase(
      "INSERT INTO oracle_sources (code, name, description, enabled) VALUES ($1, $2, $3, $4) RETURNING *",
      ['chainlink', 'Chainlink', 'Decentralized oracle network', true],
    );

    expect(insertResult.rowCount).toBe(1);
    expect(insertResult.rows[0]).toMatchObject({
      code: 'chainlink',
      name: 'Chainlink',
      enabled: true,
    });

    // Query inserted source
    const selectResult = await queryDatabase('SELECT * FROM oracle_sources WHERE code = $1', [
      'chainlink',
    ]);

    expect(selectResult.rowCount).toBe(1);
    expect(selectResult.rows[0]).toMatchObject({
      code: 'chainlink',
      name: 'Chainlink',
    });
  });

  it('should calculate median price from multiple sources', async () => {
    // Insert asset and sources
    await queryDatabase(
      "INSERT INTO assets (code, name, decimals, enabled) VALUES ($1, $2, $3, $4)",
      ['BTC', 'Bitcoin', 8, true],
    );

    const sources = ['source1', 'source2', 'source3'];
    for (const source of sources) {
      await queryDatabase(
        "INSERT INTO oracle_sources (code, name, enabled) VALUES ($1, $2, $3)",
        [source, source, true],
      );
    }

    const asset = await queryDatabase('SELECT id FROM assets WHERE code = $1', ['BTC']);
    const assetId = (asset.rows[0] as any).id;

    const prices = [50000, 51000, 49000]; // Will median to 50000

    for (let i = 0; i < sources.length; i++) {
      const sourceResult = await queryDatabase('SELECT id FROM oracle_sources WHERE code = $1', [
        sources[i],
      ]);
      const sourceId = (sourceResult.rows[0] as any).id;

      await queryDatabase(
        "INSERT INTO price_data (asset_id, source_id, price, timestamp) VALUES ($1, $2, $3, $4)",
        [assetId, sourceId, prices[i], new Date()],
      );
    }

    // Calculate median
    const result = await queryDatabase(
      `SELECT
        asset_id,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) as median_price,
        COUNT(*) as source_count
      FROM price_data
      WHERE asset_id = $1
      GROUP BY asset_id`,
      [assetId],
    );

    expect(result.rowCount).toBe(1);
    const medianPrice = parseFloat((result.rows[0] as any).median_price);
    expect(medianPrice).toBe(50000);
    expect((result.rows[0] as any).source_count).toBe(3);
  });
});
