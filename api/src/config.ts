import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.API_PORT || '3000', 10),
  wsPort: parseInt(process.env.WS_PORT || '3001', 10),
  aggregatorUrl: process.env.AGGREGATOR_URL || 'http://localhost:4000',
  stellarRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  contractId: process.env.CONTRACT_ID || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '15000', 10),
  redisUrl: process.env.REDIS_URL,
  priceCacheTtl: parseInt(process.env.PRICE_CACHE_TTL_MS || '15000', 10),
  historyCacheTtl: parseInt(process.env.HISTORY_CACHE_TTL_MS || '60000', 10),
  sourcesCacheTtl: parseInt(process.env.SOURCES_CACHE_TTL_MS || '300000', 10),
  healthCacheTtl: parseInt(process.env.HEALTH_CACHE_TTL_MS || '30000', 10),
};
