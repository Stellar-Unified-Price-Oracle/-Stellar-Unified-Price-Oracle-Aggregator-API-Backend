import dotenv from 'dotenv';
import path from 'path';
import { decryptSecret } from './services/crypto';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.API_PORT || '3000', 10),
  wsPort: parseInt(process.env.WS_PORT || '3001', 10),
  aggregatorUrl: process.env.AGGREGATOR_URL || 'http://localhost:4000',
  stellarRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  contractId: process.env.CONTRACT_ID || '',
  networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '15000', 10),
  redisUrl: process.env.REDIS_URL,
  priceCacheTtl: parseInt(process.env.PRICE_CACHE_TTL_MS || '15000', 10),
  historyCacheTtl: parseInt(process.env.HISTORY_CACHE_TTL_MS || '60000', 10),
  sourcesCacheTtl: parseInt(process.env.SOURCES_CACHE_TTL_MS || '300000', 10),
  healthCacheTtl: parseInt(process.env.HEALTH_CACHE_TTL_MS || '30000', 10),
  // Sensitive: decrypted at rest if stored as an `enc:` payload (issue #41).
  databaseUrl: process.env.DATABASE_URL ? decryptSecret(process.env.DATABASE_URL) : undefined,
  // TimescaleDB hypertable support (issue #42).
  useTimescale: process.env.USE_TIMESCALEDB !== 'false',
  // Connection pooling, retry and circuit breaker (issue #44).
  db: {
    poolMin: parseInt(process.env.DATABASE_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.DATABASE_POOL_MAX || '20', 10),
    idleTimeoutMs: parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMs: parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS || '5000', 10),
    statementTimeoutMs: parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS || '15000', 10),
    // Exponential-backoff retry for transient failures.
    retry: {
      maxRetries: parseInt(process.env.DATABASE_RETRY_MAX || '3', 10),
      baseDelayMs: parseInt(process.env.DATABASE_RETRY_BASE_DELAY_MS || '100', 10),
      maxDelayMs: parseInt(process.env.DATABASE_RETRY_MAX_DELAY_MS || '2000', 10),
    },
    // Circuit breaker to prevent thundering-herd against an unhealthy DB.
    circuitBreaker: {
      enabled: process.env.DATABASE_CIRCUIT_BREAKER_ENABLED !== 'false',
      failureThreshold: parseInt(process.env.DATABASE_CB_FAILURE_THRESHOLD || '5', 10),
      successThreshold: parseInt(process.env.DATABASE_CB_SUCCESS_THRESHOLD || '2', 10),
      openMs: parseInt(process.env.DATABASE_CB_OPEN_MS || '10000', 10),
    },
    // Read replicas for horizontal read scaling (issue #45).
    replica: {
      urls: (process.env.DATABASE_REPLICA_URLS || '')
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean)
        .map((u) => decryptSecret(u)),
      // How long a replica may lag the primary before reads fall back to the
      // primary (0 disables the lag check).
      maxLagMs: parseInt(process.env.DATABASE_REPLICA_MAX_LAG_MS || '0', 10),
      healthCheckIntervalMs: parseInt(process.env.DATABASE_REPLICA_HEALTHCHECK_MS || '10000', 10),
    },
    // Data archival / retention (issue #43).
    archival: {
      enabled: process.env.DATABASE_ARCHIVAL_ENABLED === 'true',
      retentionDays: parseInt(process.env.HISTORY_RETENTION_DAYS || '0', 10),
      archiveAfterDays: parseInt(process.env.HISTORY_ARCHIVE_AFTER_DAYS || '90', 10),
      coldStorageDir: process.env.COLD_STORAGE_DIR || './data/archive',
      batchSize: parseInt(process.env.ARCHIVAL_BATCH_SIZE || '5000', 10),
      intervalMs: parseInt(process.env.ARCHIVAL_INTERVAL_MS || '86400000', 10),
    },
  },
  // WebSocket upgrade hardening (issue #40).
  ws: {
    allowedOrigins: (process.env.WS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    requireOrigin: process.env.WS_REQUIRE_ORIGIN !== 'false',
    csrfSecret: process.env.WS_CSRF_SECRET || '',
    csrfTtlMs: parseInt(process.env.WS_CSRF_TTL_MS || '300000', 10),
    rateLimitMax: parseInt(process.env.WS_RATE_LIMIT_MAX || '20', 10),
    rateLimitWindowMs: parseInt(process.env.WS_RATE_LIMIT_WINDOW_MS || '60000', 10),
    hmacSecret: process.env.WS_HMAC_SECRET || '',
  },
  // Encryption at rest for sensitive config + historical data (issue #41).
  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
    previousKey: process.env.ENCRYPTION_KEY_PREVIOUS || '',
  },
  tracing: {
    enabled: process.env.TRACING_ENABLED === 'true',
    jaegerEndpoint: process.env.JAEGER_ENDPOINT,
    samplingRate: parseFloat(process.env.TRACING_SAMPLING_RATE || '1.0'),
    serviceName: process.env.TRACING_SERVICE_NAME || 'stellar-oracle-api',
  },
  // Response compression (gzip/brotli content negotiation).
  compression: {
    enabled: process.env.COMPRESSION_ENABLED !== 'false',
    threshold: parseInt(process.env.COMPRESSION_THRESHOLD_BYTES || '1024', 10),
    level: parseInt(process.env.COMPRESSION_LEVEL || '6', 10),
  },
};
