import crypto from 'crypto';

/**
 * Minimization rules for consumer-identifying telemetry (issue #754).
 * Policy and field inventory: docs/privacy/telemetry-retention.md
 */

export type TelemetryMode = 'full' | 'truncate' | 'hash' | 'drop';

export interface TelemetryPolicy {
  /** How client IP addresses are emitted. Default: truncate. */
  ip: TelemetryMode;
  /** Query-string keys whose values are replaced with [redacted]. */
  sensitiveQueryKeys: string[];
  /** Salt for hash mode. Without one, hash mode falls back to truncate so unsalted hashes are never emitted. */
  hashSalt?: string;
  /** Retention in days for logs that carry the minimized fields. */
  retentionDays: number;
}

export const DEFAULT_RETENTION_DAYS = 30;

export const SENSITIVE_QUERY_KEYS = [
  'api_key', 'apikey', 'key', 'token', 'access_token', 'secret', 'password', 'signature', 'authorization', 'email',
];

export function loadTelemetryPolicy(env: NodeJS.ProcessEnv = process.env): TelemetryPolicy {
  const mode = (env.TELEMETRY_IP_MODE || 'truncate').toLowerCase();
  const ip: TelemetryMode = ['full', 'truncate', 'hash', 'drop'].includes(mode) ? (mode as TelemetryMode) : 'truncate';
  const days = Number(env.TELEMETRY_RETENTION_DAYS);
  const extra = (env.TELEMETRY_SENSITIVE_QUERY_KEYS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    ip,
    sensitiveQueryKeys: [...new Set([...SENSITIVE_QUERY_KEYS, ...extra])],
    hashSalt: env.TELEMETRY_HASH_SALT || undefined,
    retentionDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_RETENTION_DAYS,
  };
}

/** Zeroes the host part: IPv4 -> /24, IPv6 -> /48. Unparseable values become 'unknown'. */
export function truncateIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const p = v4.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0`;
  }
  if (ip.includes(':')) {
    const groups = ip.split(':');
    if (groups.length < 3) return 'unknown';
    return `${groups.slice(0, 3).map((g) => g || '0').join(':')}::`;
  }
  return 'unknown';
}

export function minimizeIp(ip: string | undefined, policy: TelemetryPolicy = loadTelemetryPolicy()): string | undefined {
  switch (policy.ip) {
    case 'full':
      return ip;
    case 'drop':
      return undefined;
    case 'hash':
      if (!policy.hashSalt || !ip) return truncateIp(ip);
      return crypto.createHmac('sha256', policy.hashSalt).update(ip).digest('hex').slice(0, 16);
    default:
      return truncateIp(ip);
  }
}

/** Replaces values of sensitive keys; non-sensitive values pass through. Does not mutate the input. */
export function redactQuery(query: unknown, policy: TelemetryPolicy = loadTelemetryPolicy()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!query || typeof query !== 'object') return out;
  const sensitive = new Set(policy.sensitiveQueryKeys.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    out[k] = sensitive.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

/** Last-line guard for approved-path checks: true if the text still contains an unmasked IPv4 address or key-like token. */
export function containsIdentifier(text: string): boolean {
  const ipv4 = /\b(?!0\.0\.0\.0\b)(\d{1,3}\.){2}\d{1,3}\.(?!0\b)\d{1,3}\b/;
  const keyLike = /\b(sk|pk|key)_[A-Za-z0-9]{16,}\b/;
  return ipv4.test(text) || keyLike.test(text);
}
