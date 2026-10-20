import dotenv from 'dotenv';
import path from 'path';
import { decryptSecret } from '../governance/crypto';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export function secretEnv(name: string, fallback = ''): string {
  const value = process.env[name];
  return value ? decryptSecret(value) : fallback;
}

export function optionalSecretEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? decryptSecret(value) : undefined;
}

function commaList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `WEBHOOK_ALLOWED_HOSTS_BY_TENANT` holds a JSON object mapping an API key
 * prefix to the hosts that key's tenant may register. Unparsable or malformed
 * values are ignored rather than silently widening the allowlist.
 */
function hostMapEnv(name: string): Record<string, string[]> {
  const raw = process.env[name];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, string[]> = {};
  for (const [tenant, hosts] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(hosts)) {
      out[tenant.toLowerCase()] = hosts.map((host) => String(host).toLowerCase());
    }
  }
  return out;
}

/**
 * Outbound egress policy (issue #750).
 *
 * `EGRESS_ALLOWED_HOSTS` is the deployment-level allowlist of hosts that
 * provider/integration egress (webhooks, aggregator, RPC, etc.) may reach.
 * It is deny-by-default: an empty list blocks all outbound destinations.
 * Entries are lowercased hostnames; a leading `*.` matches any subdomain.
 *
 * `EGRESS_ALLOW_REDIRECTS` defaults to `false` so a 3xx response cannot
 * silently route traffic to a host outside the allowlist. When enabled,
 * every redirect hop is re-validated against the allowlist and the hop
 * count is capped by `EGRESS_MAX_REDIRECTS`.
 */
function egressHostList(value?: string): string[] {
  return commaList(value).filter((host) => {
    // Reject malformed entries (scheme, path, port, whitespace) so a typo
    // cannot widen the allowlist or match unintended hosts.
    if (host.includes('://') || host.includes('/') || host.includes(':')) return false;
    if (host === '*' || host === '*.') return false;
    return /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host);
  });
}

export const config = {
  sandbox: {
    enabled: process.env.SANDBOX_ENABLED === 'true',
    resetToken: secretEnv('SANDBOX_RESET_TOKEN'),
  },
  port: parseInt(process.env.API_PORT || '3000', 10),
  wsPort: parseInt(process.env.WS_PORT || '3001', 10),
  aggregatorUrl: process.env.AGGREGATOR_URL || 'http://localhost:4002',
  stellarRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  contractId: process.env.CONTRACT_ID || '',
  networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  rateLimitRedisUrls: (process.env.RATE_LIMIT_REDIS_URLS || process.env.REDIS_URL || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean),
  geoIpDatabasePath: process.env.GEOIP_DATABASE_PATH || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  publicAllowedHosts: (process.env.PUBLIC_BASE_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '15000', 10),
  redisUrl: optionalSecretEnv('REDIS_URL'),
  // Shared API key store (issue #591). Defaults to redis when REDIS_URL is
  // set, otherwise to a per-process in-memory store.
  apiKeyStore: {
    type: (process.env.API_KEY_STORE || (process.env.REDIS_URL ? 'redis' : 'memory')) as
      | 'memory'
      | 'redis',
    refreshIntervalMs: parseInt(process.env.API_KEY_STORE_REFRESH_MS || '1000', 10),
    failClosed: process.env.API_KEY_STORE_FAIL_CLOSED !== 'false',
  },
  priceCacheTtl: parseInt(process.env.PRICE_CACHE_TTL_MS || '15000', 10),
  historyCacheTtl: parseInt(process.env.HISTORY_CACHE_TTL_MS || '60000', 10),
  sourcesCacheTtl: parseInt(process.env.SOURCES_CACHE_TTL_MS || '300000', 10),
  healthCacheTtl: parseInt(process.env.HEALTH_CACHE_TTL_MS || '30000', 10),
  // Sensitive: decrypted at rest if stored as an `enc:` payload (issue #41).
  databaseUrl: optionalSecretEnv('DATABASE_URL'),
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
    csrfSecret: secretEnv('WS_CSRF_SECRET'),
    csrfTtlMs: parseInt(process.env.WS_CSRF_TTL_MS || '300000', 10),
    rateLimitMax: parseInt(process.env.WS_RATE_LIMIT_MAX || '20', 10),
    rateLimitWindowMs: parseInt(process.env.WS_RATE_LIMIT_WINDOW_MS || '60000', 10),
    maxConcurrentConnectionsPerIp: parseInt(process.env.WS_MAX_CONCURRENT_CONNECTIONS_PER_IP || '10', 10),
    hmacSecret: secretEnv('WS_HMAC_SECRET'),
    // Replay bounding and buffer caps (issue #606)
    bufferSize: parseInt(process.env.WS_BUFFER_SIZE || '200', 10),
    bufferMaxAssets: parseInt(process.env.WS_BUFFER_MAX_ASSETS || '64', 10),
    bufferMaxBytes: parseInt(process.env.WS_BUFFER_MAX_BYTES || '8388608', 10),
    replayMaxMessages: parseInt(process.env.WS_REPLAY_MAX_MESSAGES || '200', 10),
    replayMaxBytes: parseInt(process.env.WS_REPLAY_MAX_BYTES || '262144', 10),
    replayRateLimit: parseInt(process.env.WS_REPLAY_RATE_LIMIT || '10', 10),
    replayRateWindowMs: parseInt(process.env.WS_REPLAY_RATE_WINDOW_MS || '60000', 10),
  },
  // Encryption at rest for sensitive config + historical data (issue #41).
  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
    previousKey: process.env.ENCRYPTION_KEY_PREVIOUS || '',
  },
  // GraphQL preview surface (issue #607). Disabled unless explicitly enabled.
  graphql: {
    enabled: process.env.GRAPHQL_ENABLED === 'true',
    introspection: process.env.GRAPHQL_INTROSPECTION === 'true',
    maxDepth: parseInt(process.env.GRAPHQL_MAX_DEPTH || '5', 10),
    maxComplexity: parseInt(process.env.GRAPHQL_MAX_COMPLEXITY || '100', 10),
    timeoutMs: parseInt(process.env.GRAPHQL_TIMEOUT_MS || '5000', 10),
    maxQueryLength: parseInt(process.env.GRAPHQL_MAX_QUERY_LENGTH || '10000', 10),
    maxLimit: parseInt(process.env.GRAPHQL_MAX_LIMIT || '25', 10),
    allowedTiers: (process.env.GRAPHQL_ALLOWED_TIERS || 'pro,enterprise')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  },
  tracing: {
    enabled: process.env.TRACING_ENABLED === 'true',
    otlpEndpoint: process.env.OTLP_TRACE_ENDPOINT || process.env.JAEGER_ENDPOINT,
    samplingRate: parseFloat(process.env.TRACING_SAMPLING_RATE || '1.0'),
    serviceName: process.env.TRACING_SERVICE_NAME || 'stellar-oracle-api',
  },
  backup: {
    enabled: process.env.BACKUP_ENABLED === 'true',
    dir: process.env.BACKUP_DIR || './data/backups',
    // 64-char hex key; if omitted backups are stored unencrypted
    encryptionKeyHex: process.env.BACKUP_ENCRYPTION_KEY || '',
    // DR (issue #106): snapshot cadence — lower this (e.g. 300000 = 5min) in
    // production to keep Tier 2 recovery alone under the RPO target.
    intervalMs: parseInt(process.env.BACKUP_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10),
  },
  // Disaster recovery targets (issue #106) — see docs/disaster-recovery/README.md
  dr: {
    rtoTargetSeconds: parseInt(process.env.DR_RTO_TARGET_SECONDS || String(60 * 60), 10),
    rpoTargetSeconds: parseInt(process.env.DR_RPO_TARGET_SECONDS || String(5 * 60), 10),
  },
  consistency: {
    enabled: process.env.CONSISTENCY_CHECK_ENABLED !== 'false',
    checkIntervalMs: parseInt(process.env.CONSISTENCY_CHECK_INTERVAL_MS || '60000', 10),
  },
  dbHealth: {
    checkIntervalMs: parseInt(process.env.DB_HEALTH_CHECK_INTERVAL_MS || '15000', 10),
    connectionExhaustionThreshold: parseFloat(process.env.DB_HEALTH_EXHAUSTION_THRESHOLD || '0.8'),
    slowQueryThresholdMs: parseInt(process.env.DB_HEALTH_SLOW_QUERY_MS || '5000', 10),
    replicationLagAlertMs: parseInt(process.env.DB_HEALTH_REPLICA_LAG_ALERT_MS || '30000', 10),
  },
  compression: {
    enabled: process.env.COMPRESSION_ENABLED !== 'false',
    threshold: parseInt(process.env.COMPRESSION_THRESHOLD || '1024', 10),
    level: parseInt(process.env.COMPRESSION_LEVEL || '6', 10),
  },
  // Outbound egress policy (issue #750). Deny-by-default: an empty allowlist
  // blocks every outbound destination. See docs/security/egress-policy.md.
  egress: {
    allowedHosts: egressHostList(process.env.EGRESS_ALLOWED_HOSTS),
    // Redirects are refused unless explicitly enabled; each hop is re-checked.
    allowRedirects: process.env.EGRESS_ALLOW_REDIRECTS === 'true',
    maxRedirects: parseInt(process.env.EGRESS_MAX_REDIRECTS || '3', 10),
    // Re-resolve DNS on every request so a rebinding change cannot bypass the
    // allowlist between the check and the connection.
    revalidateDns: process.env.EGRESS_REVALIDATE_DNS !== 'false',
    timeoutMs: parseInt(process.env.EGRESS_TIMEOUT_MS || '10000', 10),
  },
  webhooks: {
    baseDelayMs: parseInt(process.env.WEBHOOK_BASE_DELAY_MS || '1000', 10),
    maxDelayMs: parseInt(process.env.WEBHOOK_MAX_DELAY_MS || '60000', 10),
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '5', 10),
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
    minIntervalMs: parseInt(process.env.WEBHOOK_MIN_INTERVAL_MS || '60000', 10),
    maxConcurrent: parseInt(process.env.WEBHOOK_MAX_CONCURRENT || '5', 10),
    maxPendingPerDestination: parseInt(process.env.WEBHOOK_MAX_PENDING || '100', 10),
    circuitFailureThreshold: parseInt(process.env.WEBHOOK_CIRCUIT_THRESHOLD || '3', 10),
    circuitCooldownMs: parseInt(process.env.WEBHOOK_CIRCUIT_COOLDOWN_MS || '60000', 10),
  },
};