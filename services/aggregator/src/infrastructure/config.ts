import dotenv from 'dotenv';
import path from 'path';
import { decryptSecret } from './crypto';
import { parseConfigEnv, redactConfig } from './config-schema';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function deriveSourceHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    hosts.add(new URL(url).hostname.toLowerCase());
  }
  return Array.from(hosts);
}

export interface FeedOwnership {
  primary: string;
  failover: string;
}

function buildFeedOwnership(
  parsed: ReturnType<typeof parseConfigEnv>,
  regionId: string,
): Record<string, FeedOwnership> {
  const ownership: Record<string, FeedOwnership> = {};

  // Lowest precedence: per-asset env vars.
  for (const asset of parsed.WATCHED_ASSETS) {
    const key = asset.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const primary = parsed.FEED_PRIMARY_REGION[asset] ?? parsed.FEED_PRIMARY_REGION[key];
    const failover = parsed.FEED_FAILOVER_REGION[asset] ?? parsed.FEED_FAILOVER_REGION[key];
    if (primary || failover) {
      ownership[asset] = {
        primary: (primary ?? regionId).toLowerCase(),
        failover: (failover ?? primary ?? regionId).toLowerCase(),
      };
    }
  }

  // Highest precedence: explicit JSON map.
  for (const [asset, entry] of Object.entries(parsed.FEED_OWNERSHIP_JSON)) {
    ownership[asset] = {
      primary: (entry.primary ?? regionId).toLowerCase(),
      failover: (entry.failover ?? entry.primary ?? regionId).toLowerCase(),
    };
  }

  // Default any unconfigured asset to the local region for both roles so every
  // feed always has exactly one authorized publisher.
  for (const asset of parsed.WATCHED_ASSETS) {
    if (!ownership[asset]) {
      ownership[asset] = { primary: regionId.toLowerCase(), failover: regionId.toLowerCase() };
    }
  }

  return ownership;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = parseConfigEnv(env);

  const regionId = parsed.REGION_ID ?? parsed.AWS_REGION?.trim() ?? 'local';
  const sourceUrls = [
    parsed.CHAINLINK_BASE_URL,
    parsed.REDSTONE_BASE_URL,
    parsed.BAND_BASE_URL,
    parsed.REFLECTOR_BASE_URL,
  ];

  return {
    port: parsed.PORT,
    pollingIntervalMs: parsed.POLLING_INTERVAL_MS,
    stalenessThresholdMs: parsed.STALENESS_THRESHOLD_MS,

    soroban: {
      rpcUrl: parsed.SOROBAN_RPC_URL,
      contractId: parsed.CONTRACT_ID,
      networkPassphrase: parsed.NETWORK_PASSPHRASE,
      adminSecret: decryptSecret(parsed.ADMIN_SECRET_KEY),
    },

    canary: {
      failureThreshold: parsed.CANARY_FAILURE_THRESHOLD,
      autoRollback: parsed.CANARY_AUTO_ROLLBACK,
    },

    sources: {
      chainlink: {
        baseUrl: parsed.CHAINLINK_BASE_URL,
        apiKey: decryptSecret(parsed.CHAINLINK_API_KEY),
      },
      redstone: { baseUrl: parsed.REDSTONE_BASE_URL },
      band: { baseUrl: parsed.BAND_BASE_URL },
      reflector: { baseUrl: parsed.REFLECTOR_BASE_URL },
    },

    assets: parsed.WATCHED_ASSETS,

    logLevel: parsed.LOG_LEVEL,

    region: {
      id: regionId,
      activeActive: parsed.ACTIVE_ACTIVE_REGIONS_ENABLED,
      peers: parsed.REGION_PEERS.map((peer) => peer.toLowerCase()),
      replicationTopic: parsed.REGION_REPLICATION_TOPIC,
      driftAlertPercent: parsed.REGION_DRIFT_ALERT_PERCENT,
      quarantineEnabled: parsed.REGION_QUARANTINE_ENABLED,
      quarantineRecoverPercent: parsed.REGION_QUARANTINE_RECOVER_PERCENT,
      maxReplicationLagMs: parsed.REGION_MAX_REPLICATION_LAG_MS,
    },

    // Issue #744 — surge limits applied during failover and recovery so
    // traffic/cost spikes cannot exhaust provider quotas or budgets before
    // alerts fire and safe degradation kicks in.
    surge: {
      enabled: parsed.SURGE_LIMITS_ENABLED,
      // Hard ceiling on outbound provider requests per window.
      maxRequestsPerWindow: parsed.SURGE_MAX_REQUESTS_PER_WINDOW,
      windowMs: parsed.SURGE_WINDOW_MS,
      // Fraction of the normal request rate allowed while recovering (0-1).
      recoveryRateLimit: parsed.SURGE_RECOVERY_RATE_LIMIT,
      // Estimated cost ceiling (USD) per window before degradation.
      maxCostPerWindowUsd: parsed.SURGE_MAX_COST_PER_WINDOW_USD,
      // Estimated per-request cost (USD) used by the cost model.
      costPerRequestUsd: parsed.SURGE_COST_PER_REQUEST_USD,
      // Alert thresholds as a fraction of the configured limits (0-1).
      alertThresholdPercent: parsed.SURGE_ALERT_THRESHOLD_PERCENT,
      // When limits are exceeded, degrade instead of failing hard.
      degradeOnLimit: parsed.SURGE_DEGRADE_ON_LIMIT,
    },
  },

  assets: (process.env.WATCHED_ASSETS || 'XLM,USDC,BTC,ETH,USDT').split(','),

  // Issue #579 — graceful shutdown. The drain deadline must stay smaller than
  // the deployment's terminationGracePeriodSeconds (60s in k8s/*); see
  // docs/PRODUCTION_DEPLOYMENT.md §10 for the arithmetic.
  shutdown: {
    drainDeadlineMs: parseInt(process.env.SHUTDOWN_DRAIN_DEADLINE_MS || '25000', 10),
    forceExitMs: parseInt(process.env.SHUTDOWN_FORCE_EXIT_MS || '35000', 10),
  },

  logLevel: process.env.LOG_LEVEL || 'info',

  region: {
    id: process.env.REGION_ID || process.env.AWS_REGION || 'local',
    activeActive: process.env.ACTIVE_ACTIVE_REGIONS_ENABLED === 'true',
    peers: commaList(process.env.REGION_PEERS),
    replicationTopic: process.env.REGION_REPLICATION_TOPIC || 'stellar-oracle-prices',
    driftAlertPercent: parseFloat(process.env.REGION_DRIFT_ALERT_PERCENT || '0.1'),
    quarantineEnabled: process.env.REGION_QUARANTINE_ENABLED === 'true',
    quarantineRecoverPercent: parseFloat(process.env.REGION_QUARANTINE_RECOVER_PERCENT || '0.05'),
    maxReplicationLagMs: parseInt(process.env.REGION_MAX_REPLICATION_LAG_MS || '5000', 10),
  },

  database: {
    url: decryptSecret(process.env.DATABASE_URL || ''),
    // TimescaleDB: convert the price_history table into a hypertable when available.
    useTimescale: process.env.USE_TIMESCALEDB !== 'false',
    // Chunk interval in seconds for the integer `timestamp` time dimension (default 7 days).
    chunkIntervalSeconds: parseInt(process.env.TIMESCALE_CHUNK_INTERVAL_SECONDS || '604800', 10),
    retentionDays: parseInt(process.env.HISTORY_RETENTION_DAYS || '0', 10),
  },

  // Caps applied to file-based history on every append (issue #214), so the
  // JSON files under data/ cannot grow without bound. Set either to 0 to disable.
  history: {
    maxEntries: parseInt(process.env.HISTORY_MAX_ENTRIES || '10000', 10),
    retentionSeconds: parseInt(process.env.HISTORY_RETENTION_SECONDS || '604800', 10),
    // File-based archival to cold storage (issue #43).
    archival: {
      enabled: process.env.FILE_ARCHIVAL_ENABLED === 'true',
      archiveAfterDays: parseInt(process.env.FILE_ARCHIVE_AFTER_DAYS || '90', 10),
      retentionDays: parseInt(process.env.FILE_RETENTION_DAYS || '0', 10),
      coldStorageDir: process.env.FILE_COLD_STORAGE_DIR || './data/archive',
      intervalMs: parseInt(process.env.FILE_ARCHIVAL_INTERVAL_MS || '86400000', 10),
    },

    database: {
      url: decryptSecret(parsed.DATABASE_URL),
      useTimescale: parsed.USE_TIMESCALEDB,
      chunkIntervalSeconds: parsed.TIMESCALE_CHUNK_INTERVAL_SECONDS,
      retentionDays: parsed.HISTORY_RETENTION_DAYS,
    },
    // WebSocket upgrade hardening (issue #40, #586).
    websocket: {
      allowedOrigins: commaList(process.env.WS_ALLOWED_ORIGINS),
      requireOrigin: process.env.WS_REQUIRE_ORIGIN !== 'false',
      maxConnectionsPerWindow: parseInt(process.env.WS_RATE_LIMIT_MAX || '20', 10),
      rateLimitWindowMs: parseInt(process.env.WS_RATE_LIMIT_WINDOW_MS || '60000', 10),
    },

    security: {
      ssrf: {
        enabled: parsed.SSRF_PROTECTION_ENABLED,
        allowedHosts: [...deriveSourceHosts(sourceUrls), ...parsed.ORACLE_ALLOWED_HOSTS],
        allowPrivateIps: parsed.SSRF_ALLOW_PRIVATE_IPS,
        requestTimeoutMs: parsed.OUTBOUND_REQUEST_TIMEOUT_MS,
      },
      // Issue #750 — outbound egress policy. Every provider/integration
      // destination must match this allowlist; redirects are re-validated
      // against it and DNS answers are pinned to the resolved address so a
      // DNS change cannot silently widen egress. The allowlist is derived from
      // the configured source hosts plus ORACLE_ALLOWED_HOSTS, so it is
      // environment-specific by construction (dev/staging/prod each set their
      // own source URLs). See docs/EGRESS_POLICY.md for rollout/rollback.
      egress: {
        enabled: parsed.EGRESS_POLICY_ENABLED,
        allowedHosts: [...deriveSourceHosts(sourceUrls), ...parsed.ORACLE_ALLOWED_HOSTS],
        allowPrivateIps: parsed.SSRF_ALLOW_PRIVATE_IPS,
        // Redirects are followed only when the new destination is also allowed.
        followRedirects: parsed.EGRESS_FOLLOW_REDIRECTS,
        maxRedirects: parsed.EGRESS_MAX_REDIRECTS,
        // Pin DNS resolution for the lifetime of a request to defeat rebinding.
        pinDns: parsed.EGRESS_PIN_DNS,
        requestTimeoutMs: parsed.OUTBOUND_REQUEST_TIMEOUT_MS,
      },
      websocket: {
        allowedOrigins: parsed.WS_ALLOWED_ORIGINS,
        requireOrigin: parsed.WS_REQUIRE_ORIGIN,
        maxConnectionsPerWindow: parsed.WS_RATE_LIMIT_MAX,
        rateLimitWindowMs: parsed.WS_RATE_LIMIT_WINDOW_MS,
      },
      encryption: {
        key: parsed.ENCRYPTION_KEY,
        previousKey: parsed.ENCRYPTION_KEY_PREVIOUS,
        encryptHistory: parsed.ENCRYPT_HISTORY,
      },
    },

    websocket: {
      maxSubscriptions: parsed.WS_MAX_SUBSCRIPTIONS,
      dropBufferBytes: parsed.WS_BACKPRESSURE_DROP_BYTES,
      pingIntervalMs: parsed.WS_PING_INTERVAL_MS,
      pingTimeoutMs: parsed.WS_PING_TIMEOUT_MS,
      maxClientMessageBytes: parsed.WS_MAX_CLIENT_MESSAGE_BYTES,
    },
  };
}

export type AggregatorConfig = ReturnType<typeof loadConfig>;

export function redactedConfigView(value: AggregatorConfig): unknown {
  return redactConfig(value);
}

function isCheckConfigRequest(): boolean {
  return process.argv.includes('--check-config');
}

function failFast(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function isTestRunner(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

export const config: AggregatorConfig = (() => {
  try {
    const resolved = loadConfig(process.env);
    if (isCheckConfigRequest()) {
      console.log(JSON.stringify(redactedConfigView(resolved), null, 2));
      process.exit(0);
    }
    return resolved;
  } catch (error) {
    if (!isTestRunner()) failFast(error);
    throw error;
  }
})();
