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
};
