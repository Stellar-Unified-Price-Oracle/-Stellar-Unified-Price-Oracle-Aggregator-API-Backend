import { assertSandboxIsolation } from '../oracle-sources/sandbox-credentials';
import dotenv from 'dotenv';
import path from 'path';
import { decryptSecret } from './crypto';
import { parseConfigEnv, redactConfig } from './config-schema';
import { logger } from '../observability/logger';

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
  assertSandboxIsolation(env);
  const parsed = parseConfigEnv(env);

  const regionId = parsed.REGION_ID ?? parsed.AWS_REGION?.trim() ?? 'local';

  // Issue #685 — region-scoped provider configuration.
  const regionSuffix = `_${regionId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const regionScoped = <T extends string>(envs: NodeJS.ProcessEnv, varName: string): T | undefined =>
    envs[`${varName}${regionSuffix}`] as T | undefined;

  const isHttpUrl = (value: string | undefined): boolean => {
    if (!value) return false;
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const resolveBaseUrl = (globalUrl: string, varName: string): string => {
    const scoped = regionScoped(env, varName);
    if (scoped && isHttpUrl(scoped)) return scoped;
    if (scoped) {
      logger.warn(
        `[RegionConfig] Ignoring invalid region-scoped ${varName} for region ${regionId} — falling back to global endpoint`,
      );
    }
    return globalUrl;
  };

  const resolveApiKey = (globalKey: string, varName: string): string => {
    const scoped = regionScoped(env, varName);
    return scoped && scoped.length > 0 ? scoped : globalKey;
  };

  // Collect every source host (global + region-scoped) so the SSRF allowlist
  // covers the endpoints this region will actually call out to.
  const sourceUrls: string[] = [];
  for (const varName of [
    'CHAINLINK_BASE_URL',
    'REDSTONE_BASE_URL',
    'BAND_BASE_URL',
    'REFLECTOR_BASE_URL',
  ] as const) {
    sourceUrls.push(parsed[varName]);
    const scoped = regionScoped(env, varName);
    if (scoped && isHttpUrl(scoped)) sourceUrls.push(scoped);
  }

  // Issue #685 — no cross-environment leakage: a region-scoped credential must
  // not silently reuse the global credential.
  for (const varName of ['CHAINLINK_API_KEY'] as const) {
    const scoped = regionScoped(env, varName);
    if (
      scoped &&
      scoped.length > 0 &&
      parsed[varName] &&
      scoped === parsed[varName]
    ) {
      logger.warn(
        `[RegionConfig] Region ${regionId} ${varName} equals the global value — potential cross-environment leakage; use a region-scoped secret`,
      );
    }
  }

  const feedOwnership = buildFeedOwnership(parsed, regionId);

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
        baseUrl: resolveBaseUrl(parsed.CHAINLINK_BASE_URL, 'CHAINLINK_BASE_URL'),
        apiKey: decryptSecret(resolveApiKey(parsed.CHAINLINK_API_KEY, 'CHAINLINK_API_KEY')),
      },
      redstone: { baseUrl: resolveBaseUrl(parsed.REDSTONE_BASE_URL, 'REDSTONE_BASE_URL') },
      band: { baseUrl: resolveBaseUrl(parsed.BAND_BASE_URL, 'BAND_BASE_URL') },
      reflector: { baseUrl: resolveBaseUrl(parsed.REFLECTOR_BASE_URL, 'REFLECTOR_BASE_URL') },
    },

    assets: parsed.WATCHED_ASSETS,

    feedOwnership,

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

    // Issue #744 — surge limits applied during failover and recovery.
    surge: {
      enabled: parsed.SURGE_LIMITS_ENABLED,
      maxRequestsPerWindow: parsed.SURGE_MAX_REQUESTS_PER_WINDOW,
      windowMs: parsed.SURGE_WINDOW_MS,
      recoveryRateLimit: parsed.SURGE_RECOVERY_RATE_LIMIT,
      maxCostPerWindowUsd: parsed.SURGE_MAX_COST_PER_WINDOW_USD,
      costPerRequestUsd: parsed.SURGE_COST_PER_REQUEST_USD,
      alertThresholdPercent: parsed.SURGE_ALERT_THRESHOLD_PERCENT,
      degradeOnLimit: parsed.SURGE_DEGRADE_ON_LIMIT,
    },

    shutdown: {
      drainDeadlineMs: parseInt(process.env.SHUTDOWN_DRAIN_DEADLINE_MS || '25000', 10),
      forceExitMs: parseInt(process.env.SHUTDOWN_FORCE_EXIT_MS || '35000', 10),
    },

    database: {
      url: decryptSecret(parsed.DATABASE_URL),
      useTimescale: parsed.USE_TIMESCALEDB,
      chunkIntervalSeconds: parsed.TIMESCALE_CHUNK_INTERVAL_SECONDS,
      retentionDays: parsed.HISTORY_RETENTION_DAYS,
    },

    history: {
      maxEntries: parsed.HISTORY_MAX_ENTRIES,
      retentionSeconds: parsed.HISTORY_RETENTION_SECONDS,
      archival: {
        enabled: parsed.FILE_ARCHIVAL_ENABLED,
        archiveAfterDays: parsed.FILE_ARCHIVE_AFTER_DAYS,
        retentionDays: parsed.FILE_RETENTION_DAYS,
        coldStorageDir: parsed.FILE_COLD_STORAGE_DIR,
        intervalMs: parsed.FILE_ARCHIVAL_INTERVAL_MS,
      },
      database: {
        url: decryptSecret(parsed.DATABASE_URL),
        useTimescale: parsed.USE_TIMESCALEDB,
        chunkIntervalSeconds: parsed.TIMESCALE_CHUNK_INTERVAL_SECONDS,
        retentionDays: parsed.HISTORY_RETENTION_DAYS,
      },
    },

    websocket: {
      maxSubscriptions: parsed.WS_MAX_SUBSCRIPTIONS,
      dropBufferBytes: parsed.WS_BACKPRESSURE_DROP_BYTES,
      pingIntervalMs: parsed.WS_PING_INTERVAL_MS,
      pingTimeoutMs: parsed.WS_PING_TIMEOUT_MS,
      maxClientMessageBytes: parsed.WS_MAX_CLIENT_MESSAGE_BYTES,
    },

    security: {
      ssrf: {
        enabled: parsed.SSRF_PROTECTION_ENABLED,
        allowedHosts: [...deriveSourceHosts(sourceUrls), ...parsed.ORACLE_ALLOWED_HOSTS],
        allowPrivateIps: parsed.SSRF_ALLOW_PRIVATE_IPS,
        requestTimeoutMs: parsed.OUTBOUND_REQUEST_TIMEOUT_MS,
      },
      // Issue #750 — outbound egress policy.
      egress: {
        enabled: parsed.EGRESS_POLICY_ENABLED,
        allowedHosts: [...deriveSourceHosts(sourceUrls), ...parsed.ORACLE_ALLOWED_HOSTS],
        allowPrivateIps: parsed.SSRF_ALLOW_PRIVATE_IPS,
        followRedirects: parsed.EGRESS_FOLLOW_REDIRECTS,
        maxRedirects: parsed.EGRESS_MAX_REDIRECTS,
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
