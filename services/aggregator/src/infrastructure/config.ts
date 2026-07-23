import dotenv from 'dotenv';
import path from 'path';
import { URL } from 'url';
import { decryptSecret } from './crypto';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const sourceUrls = {
  chainlink: process.env.CHAINLINK_BASE_URL || 'https://min-api.cryptocompare.com/data',
  redstone: process.env.REDSTONE_BASE_URL || 'https://api.redstone.finance',
  band: process.env.BAND_BASE_URL || 'https://laozi1.bandchain.org/api',
  reflector: process.env.REFLECTOR_BASE_URL || 'https://api.reflector.xyz',
};

/** Hostnames extracted from the configured source URLs — the implicit allowlist. */
function deriveSourceHosts(): string[] {
  const hosts = new Set<string>();
  for (const url of Object.values(sourceUrls)) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      /* ignore malformed source URLs */
    }
  }
  return Array.from(hosts);
}

function commaList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '30000', 10),
  stalenessThresholdMs: parseInt(process.env.STALENESS_THRESHOLD_MS || '120000', 10),

  soroban: {
    rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    contractId: process.env.CONTRACT_ID || '',
    networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    // Sensitive: decrypted at rest if stored as an `enc:` payload (issue #41).
    adminSecret: decryptSecret(process.env.ADMIN_SECRET_KEY || ''),
  },

  sources: {
    chainlink: {
      baseUrl: sourceUrls.chainlink,
      apiKey: decryptSecret(process.env.CHAINLINK_API_KEY || ''),
    },
    redstone: {
      baseUrl: sourceUrls.redstone,
    },
    band: {
      baseUrl: sourceUrls.band,
    },
    reflector: {
      baseUrl: sourceUrls.reflector,
    },
  },

  assets: (process.env.WATCHED_ASSETS || 'XLM,USDC,BTC,ETH,USDT').split(','),

  logLevel: process.env.LOG_LEVEL || 'info',

  database: {
    url: decryptSecret(process.env.DATABASE_URL || ''),
    // TimescaleDB: convert the price_history table into a hypertable when available.
    useTimescale: process.env.USE_TIMESCALEDB !== 'false',
    // Chunk interval in seconds for the integer `timestamp` time dimension (default 7 days).
    chunkIntervalSeconds: parseInt(process.env.TIMESCALE_CHUNK_INTERVAL_SECONDS || '604800', 10),
    retentionDays: parseInt(process.env.HISTORY_RETENTION_DAYS || '0', 10),
  },

  security: {
    // SSRF protection for outbound oracle-source HTTP requests (issue #39).
    ssrf: {
      enabled: process.env.SSRF_PROTECTION_ENABLED !== 'false',
      // Configured source hosts plus any explicitly allowlisted extras.
      allowedHosts: [...deriveSourceHosts(), ...commaList(process.env.ORACLE_ALLOWED_HOSTS)],
      allowPrivateIps: process.env.SSRF_ALLOW_PRIVATE_IPS === 'true',
      requestTimeoutMs: parseInt(process.env.OUTBOUND_REQUEST_TIMEOUT_MS || '10000', 10),
    },
    // WebSocket upgrade hardening (issue #40).
    websocket: {
      allowedOrigins: commaList(process.env.WS_ALLOWED_ORIGINS),
      requireOrigin: process.env.WS_REQUIRE_ORIGIN !== 'false',
      maxConnectionsPerWindow: parseInt(process.env.WS_RATE_LIMIT_MAX || '20', 10),
      rateLimitWindowMs: parseInt(process.env.WS_RATE_LIMIT_WINDOW_MS || '60000', 10),
    },
    // Encryption at rest for sensitive config + historical data (issue #41).
    encryption: {
      key: process.env.ENCRYPTION_KEY || '',
      previousKey: process.env.ENCRYPTION_KEY_PREVIOUS || '',
      encryptHistory: process.env.ENCRYPT_HISTORY === 'true',
    },
  },
};
