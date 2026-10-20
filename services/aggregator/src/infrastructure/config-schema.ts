import { z } from 'zod';
import { MAX_CURATED_ASSETS } from '../observability/cardinality-budget';

export interface ConfigIssue {
  variable: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      [
        `Invalid aggregator configuration (${issues.length} problem${issues.length === 1 ? '' : 's'}):`,
        ...issues.map((issue) => `  - ${issue.variable}: ${issue.message}`),
        'Run `npm run check-config` to print the resolved configuration.',
      ].join('\n'),
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;
const BROWNOUT_TIERS = ['none', 'tier1', 'tier2', 'tier3'] as const;
const ASSET_SYMBOL = /^[A-Z0-9][A-Z0-9:_-]{0,31}$/;
const REGION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX_KEY_64 = /^[0-9a-f]{64}$/i;

const INT_PATTERN = /^[+-]?\d+$/;
const FLOAT_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function intVar(defaultValue: number, min: number, max: number) {
  const range = `integer in [${min}, ${max}]`;
  return z.preprocess(
    (value) => (value === undefined ? defaultValue : value),
    z
      .union([z.string(), z.number()])
      .transform((value) => String(value))
      .pipe(z.string().regex(INT_PATTERN, `expected ${range}`))
      .transform((value) => Number(value))
      .pipe(
        z
          .number()
          .int(`expected ${range}`)
          .min(min, `expected ${range}`)
          .max(max, `expected ${range}`),
      ),
  );
}

function floatVar(defaultValue: number, min: number, max: number) {
  const range = `number in [${min}, ${max}]`;
  return z.preprocess(
    (value) => (value === undefined ? defaultValue : value),
    z
      .union([z.string(), z.number()])
      .transform((value) => String(value))
      .pipe(z.string().regex(FLOAT_PATTERN, `expected ${range}`))
      .transform((value) => Number(value))
      .pipe(z.number().min(min, `expected ${range}`).max(max, `expected ${range}`)),
  );
}

function boolVar(defaultValue: boolean) {
  return z
    .enum(['true', 'false'], {
      errorMap: () => ({ message: 'expected "true" or "false"' }),
    })
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value === 'true'));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function urlVar(defaultValue: string) {
  return z
    .string({ invalid_type_error: 'expected an absolute http(s) URL' })
    .min(1, 'must not be empty')
    .refine(isHttpUrl, 'expected an absolute http(s) URL')
    .default(defaultValue);
}

function csvVar(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const commaListSchema = (variable: string, validate: (entry: string) => boolean, hint: string) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const segments = raw === undefined || raw.trim() === '' ? [] : raw.split(',');
      for (const segment of segments) {
        if (segment.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${variable} contains an empty comma-separated entry`,
          });
          return z.NEVER;
        }
      }
      const entries = csvVar(raw);
      for (const entry of entries) {
        if (!validate(entry)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${variable} entry "${entry}" is invalid (${hint})`,
          });
          return z.NEVER;
        }
      }
      return entries;
    });

const DEFAULT_WATCHED_ASSETS = 'XLM,USDC,BTC,ETH,USDT';

const DEPLOYMENT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

const EGRESS_HOST_PATTERN =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const REDIRECT_POLICIES = ['deny', 'same-host', 'allowlist'] as const;
type RedirectPolicy = (typeof REDIRECT_POLICIES)[number];

const DEFAULT_EGRESS_ALLOWLIST: Record<DeploymentEnvironment, string[]> = {
  development: [],
  staging: [],
  production: [],
};

const DEFAULT_REDIRECT_POLICY: Record<DeploymentEnvironment, RedirectPolicy> = {
  development: 'deny',
  staging: 'deny',
  production: 'deny',
};

function normalizeEgressHost(entry: string): string | undefined {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed === '') return undefined;
  let hostname = trimmed;
  if (trimmed.includes('://')) {
    try {
      hostname = new URL(trimmed).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  hostname = hostname.replace(/\.$/, '');
  if (hostname === '' || hostname.length > 253) return undefined;
  if (!EGRESS_HOST_PATTERN.test(hostname)) return undefined;
  return hostname;
}

const assetsSchema = z
  .string({ invalid_type_error: 'expected a comma-separated list of asset symbols' })
  .optional()
  .transform((raw, ctx) => {
    const segments = raw === undefined ? DEFAULT_WATCHED_ASSETS.split(',') : raw.split(',');
    for (const segment of segments) {
      if (segment.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'contains an empty asset symbol (no empty or whitespace-only entries)',
        });
        return z.NEVER;
      }
    }
    const normalized = Array.from(
      new Set(segments.map((segment) => segment.trim().toUpperCase())),
    );
    for (const asset of normalized) {
      if (!ASSET_SYMBOL.test(asset)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `asset symbol "${asset}" is invalid (allowed: A-Z 0-9 : _ -, max 32 chars)`,
        });
        return z.NEVER;
      }
    }
    if (normalized.length > MAX_CURATED_ASSETS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${normalized.length} assets exceed the curated asset budget of ${MAX_CURATED_ASSETS}`,
      });
      return z.NEVER;
    }
    return normalized;
  });

const envShape = {
    PORT: intVar(4000, 1, 65535),
    POLLING_INTERVAL_MS: intVar(30000, 100, 3_600_000),
    STALENESS_THRESHOLD_MS: intVar(120000, 1, 86_400_000),

    SOROBAN_RPC_URL: urlVar('https://soroban-testnet.stellar.org'),
    CONTRACT_ID: z.string().default(''),
    NETWORK_PASSPHRASE: z.string().min(1, 'must not be empty').default('Test SDF Network ; September 2015'),
    ADMIN_SECRET_KEY: z.string().default(''),

    CANARY_FAILURE_THRESHOLD: intVar(3, 1, 100),
    CANARY_AUTO_ROLLBACK: boolVar(true),

    CHAINLINK_BASE_URL: urlVar('https://min-api.cryptocompare.com/data'),
    CHAINLINK_API_KEY: z.string().default(''),
    REDSTONE_BASE_URL: urlVar('https://api.redstone.finance'),
    BAND_BASE_URL: urlVar('https://laozi1.bandchain.org/api'),
    REFLECTOR_BASE_URL: urlVar('https://api.reflector.xyz'),

    WATCHED_ASSETS: assetsSchema,

    LOG_LEVEL: z
      .enum(LOG_LEVELS, {
        errorMap: () => ({ message: `expected one of ${LOG_LEVELS.join(', ')}` }),
      })
      .default('info'),

    REGION_ID: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw.trim() === '') return undefined;
        const value = raw.trim().toLowerCase();
        if (!REGION_ID.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${raw}" is not a valid region id (lowercase letters, digits and dashes)`,
          });
          return z.NEVER;
        }
        return value;
      }),
    AWS_REGION: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value.trim() === '' ? undefined : value)),
    ACTIVE_ACTIVE_REGIONS_ENABLED: boolVar(false),
    REGION_PEERS: commaListSchema(
      'REGION_PEERS',
      (entry) => REGION_ID.test(entry.toLowerCase()),
      'lowercase letters, digits and dashes',
    ),
    REGION_REPLICATION_TOPIC: z
      .string()
      .min(1, 'must not be empty')
      .regex(/^[a-zA-Z0-9._-]{1,249}$/, 'expected a Kafka topic name')
      .default('stellar-oracle-prices'),
    REGION_DRIFT_ALERT_PERCENT: floatVar(0.1, 0, 100),
    REGION_QUARANTINE_ENABLED: boolVar(false),
    REGION_QUARANTINE_RECOVER_PERCENT: floatVar(0.05, 0, 100),
    REGION_MAX_REPLICATION_LAG_MS: intVar(5000, 1, 600_000),

    BROWNOUT_TIER: z
      .enum(BROWNOUT_TIERS, {
        errorMap: () => ({ message: `expected one of ${BROWNOUT_TIERS.join(', ')}` }),
      })
      .default('none'),
    BROWNOUT_MAX_PRICE_AGE_MS: intVar(120000, 1, 86_400_000),
    BROWNOUT_SHED_HISTORY: boolVar(false),
    BROWNOUT_SHED_ARCHIVAL: boolVar(false),
    BROWNOUT_SHED_NON_CRITICAL_FEEDS: boolVar(false),

    MAINTENANCE_WINDOW_ENABLED: boolVar(false),
    MAINTENANCE_DRAIN_TIMEOUT_MS: intVar(60000, 1000, 3_600_000),
    MAINTENANCE_PRECHECK_MAX_STALENESS_MS: intVar(120000, 1, 86_400_000),
    MAINTENANCE_PRECHECK_MIN_HEALTHY_PEERS: intVar(1, 0, 100),
    MAINTENANCE_PUBLISHER_FENCING_ENABLED: boolVar(true),
    MAINTENANCE_POSTCHECK_TIMEOUT_MS: intVar(120000, 1000, 3_600_000),

    KAFKA_BROKERS: commaListSchema(
======>>> REPLACE
export type RawEnvConfig = z.infer<typeof envSchema>;

export interface CellConfig {
  /** Cell identifier; `default` preserves single-cell behaviour. */
  id: string;
  /** True when CELL_ID was not set and the service runs as the single default cell. */
  isDefault: boolean;
  /** Upper-cased asset symbols owned by this cell (empty means all watched assets). */
  assignedFeeds: string[];
  /** Per-cell dependency overrides; undefined falls back to the global setting. */
  dbUrl?: string;
  cacheUrl?: string;
  providerUrls: string[];
}

export const DEFAULT_CELL_ID = 'default';

export function resolveCellConfig(config: RawEnvConfig): CellConfig {
  const isDefault = config.CELL_ID === undefined;
  return {
    id: config.CELL_ID ?? DEFAULT_CELL_ID,
    isDefault,
    assignedFeeds: Array.from(
      new Set((config.CELL_ASSIGNED_FEEDS ?? []).map((feed) => feed.toUpperCase())),
    ),
    dbUrl: config.CELL_DB_URL,
    cacheUrl: config.CELL_CACHE_URL,
    providerUrls: config.CELL_PROVIDER_URLS ?? [],
  };
}
      'KAFKA_BROKERS',
      (entry) => entry.length > 0 && entry.length <= 253 && !/\s/.test(entry),
      'expected a bootstrap broker as host or host:port',
    ),
    KAFKA_SSL_ENABLED: boolVar(false),

    DATABASE_URL: z.string().default(''),
    USE_TIMESCALEDB: boolVar(true),
    TIMESCALE_CHUNK_INTERVAL_SECONDS: intVar(604800, 60, 2_592_000),
    HISTORY_RETENTION_DAYS: intVar(0, 0, 3650),

    HISTORY_MAX_ENTRIES: intVar(10000, 0, 10_000_000),
    HISTORY_RETENTION_SECONDS: intVar(604800, 0, 315_360_000),

    FILE_ARCHIVAL_ENABLED: boolVar(false),
    FILE_ARCHIVE_AFTER_DAYS: intVar(90, 1, 3650),
    FILE_RETENTION_DAYS: intVar(0, 0, 3650),
    FILE_COLD_STORAGE_DIR: z.string().min(1, 'must not be empty').default('./data/archive'),
    FILE_ARCHIVAL_INTERVAL_MS: intVar(86_400_000, 1000, 604_800_000),

    SSRF_PROTECTION_ENABLED: boolVar(true),
    ORACLE_ALLOWED_HOSTS: commaListSchema(
      'ORACLE_ALLOWED_HOSTS',
      (entry) => {
        if (/\s/.test(entry)) return false;
        try {
          const url = entry.includes('://') ? entry : `https://${entry}`;
          return Boolean(new URL(url).hostname);
        } catch {
          return false;
        }
      },
      'expected a hostname or absolute URL',
    ),
    SSRF_ALLOW_PRIVATE_IPS: boolVar(false),
    OUTBOUND_REQUEST_TIMEOUT_MS: intVar(10000, 100, 300_000),

    DEPLOYMENT_ENVIRONMENT: z
      .enum(DEPLOYMENT_ENVIRONMENTS, {
        errorMap: () => ({ message: `expected one of ${DEPLOYMENT_ENVIRONMENTS.join(', ')}` }),
      })
      .default('development'),
    EGRESS_ALLOWLIST: commaListSchema(
      'EGRESS_ALLOWLIST',
      (entry) => normalizeEgressHost(entry) !== undefined,
      'expected a hostname, *.wildcard hostname or absolute URL',
    ),
    EGRESS_REDIRECT_POLICY: z
      .enum(REDIRECT_POLICIES, {
        errorMap: () => ({ message: `expected one of ${REDIRECT_POLICIES.join(', ')}` }),
      })
      .optional(),
    EGRESS_MAX_REDIRECTS: intVar(0, 0, 10),
    EGRESS_DNS_REVALIDATE: boolVar(true),

    WS_ALLOWED_ORIGINS: commaListSchema(
      'WS_ALLOWED_ORIGINS',
      (entry) => /^https?:\/\/[^/\s]+$/.test(entry) || entry === '*',
      'expected an origin such as https://example.com',
    ),
    WS_REQUIRE_ORIGIN: boolVar(true),
    WS_RATE_LIMIT_MAX: intVar(20, 1, 10_000),
    WS_RATE_LIMIT_WINDOW_MS: intVar(60000, 1000, 3_600_000),
    WS_MAX_SUBSCRIPTIONS: intVar(100, 1, 10_000),
    WS_BACKPRESSURE_DROP_BYTES: intVar(1_048_576, 1024, 268_435_456),
    WS_PING_INTERVAL_MS: intVar(30_000, 1000, 600_000),
    WS_PING_TIMEOUT_MS: intVar(10_000, 1000, 600_000),
    WS_MAX_CLIENT_MESSAGE_BYTES: intVar(4096, 256, 65_536),

    ENCRYPTION_KEY: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        const value = raw ?? '';
        if (value !== '' && !HEX_KEY_64.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'expected 64 hexadecimal characters (32 bytes) or an empty value',
          });
          return z.NEVER;
        }
        return value;
      }),
    ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        const value = raw ?? '';
        if (value !== '' && !HEX_KEY_64.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'expected 64 hexadecimal characters (32 bytes) or an empty value',
          });
          return z.NEVER;
        }
        return value;
      }),
    ENCRYPT_HISTORY: boolVar(false),
};

export const AGGREGATOR_ENV_KEYS = Object.keys(envShape).sort();

const envSchema = z.object(envShape).superRefine((value, ctx) => {
  if (value.REGION_QUARANTINE_RECOVER_PERCENT > value.REGION_DRIFT_ALERT_PERCENT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REGION_QUARANTINE_RECOVER_PERCENT'],
      message:
        `must be <= REGION_DRIFT_ALERT_PERCENT (${value.REGION_DRIFT_ALERT_PERCENT}) ` +
        'otherwise a quarantined region can never recover',
    });
  }
  if (value.BROWNOUT_MAX_PRICE_AGE_MS > value.STALENESS_THRESHOLD_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BROWNOUT_MAX_PRICE_AGE_MS'],
      message:
        `must be <= STALENESS_THRESHOLD_MS (${value.STALENESS_THRESHOLD_MS}) ` +
        'otherwise brownout mode can serve prices the normal path would reject',
    });
  }
  if (value.MAINTENANCE_PRECHECK_MAX_STALENESS_MS > value.STALENESS_THRESHOLD_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAINTENANCE_PRECHECK_MAX_STALENESS_MS'],
      message:
        `must be <= STALENESS_THRESHOLD_MS (${value.STALENESS_THRESHOLD_MS}) ` +
        'otherwise maintenance prechecks accept stale prices',
    });
  }
  if (value.MAINTENANCE_WINDOW_ENABLED && value.REGION_PEERS.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REGION_PEERS'],
      message:
        'must list at least one peer when MAINTENANCE_WINDOW_ENABLED is true ' +
        'so traffic can be drained before maintenance',
    });
  }
  if (value.MAINTENANCE_WINDOW_ENABLED && value.MAINTENANCE_PRECHECK_MIN_HEALTHY_PEERS === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAINTENANCE_PRECHECK_MIN_HEALTHY_PEERS'],
      message:
        'must be >= 1 when MAINTENANCE_WINDOW_ENABLED is true ' +
        'so maintenance cannot start without a healthy peer to take over',
    });
  }
});

export type RawEnvConfig = z.infer<typeof envSchema>;

export interface EgressPolicy {
  environment: DeploymentEnvironment;
  allowedHosts: string[];
  redirectPolicy: RedirectPolicy;
  maxRedirects: number;
  revalidateDns: boolean;
}

export function resolveEgressPolicy(config: RawEnvConfig): EgressPolicy {
  const environment = config.DEPLOYMENT_ENVIRONMENT;
  const allowedHosts = Array.from(
    new Set(
      (config.EGRESS_ALLOWLIST ?? [])
        .map((entry) => normalizeEgressHost(entry))
        .filter((host): host is string => host !== undefined),
    ),
  ).sort();
  return {
    environment,
    allowedHosts,
    redirectPolicy: config.EGRESS_REDIRECT_POLICY ?? DEFAULT_REDIRECT_POLICY[environment],
    maxRedirects: config.EGRESS_MAX_REDIRECTS,
    revalidateDns: config.EGRESS_DNS_REVALIDATE,
  };
}

export function parseConfigEnv(env: NodeJS.ProcessEnv): RawEnvConfig {
  const result = envSchema.safeParse(env);
  if (result.success) return result.data;
  throw new ConfigValidationError(
    result.error.issues.map((issue) => ({
      variable: String(issue.path[0] ?? 'environment'),
      message: issue.message,
    })),
  );
}

const SECRET_KEY_PATTERN = /(secret|password|credential|apikey|api_key|private)/i;

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '***';
  if (key === 'adminSecret' || (key === 'key' && typeof value === 'string' && value.length > 0)) {
    return '***';
  }
  if (key === 'url' && typeof value === 'string') {
    return value.replace(/(:\/\/[^:/@\s]+):([^@\s]*)@/, '$1:***@');
  }
  return value;
}

export function redactConfig(value: unknown, key = ''): unknown {
  const redacted = redactValue(key, value);
  if (redacted !== value) return redacted;
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactConfig(entryValue, entryKey),
      ]),
    );
  }
  return value;
}
