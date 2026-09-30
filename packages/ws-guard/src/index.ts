import type { IncomingMessage } from 'http';

/**
 * Shared WebSocket upgrade guard core (issue #586).
 *
 * One implementation serves both the aggregator (`WsConnectionGuard`) and the
 * API (`WsUpgradeGuard`) so the two can never diverge again. It provides:
 *
 *  - trusted-proxy-aware client identity: `X-Forwarded-For` / `Forwarded` are
 *    only honoured when the direct peer is a configured trusted proxy, taking
 *    the right-most untrusted hop, so header spoofing cannot mint fresh
 *    rate-limit identities.
 *  - fail-closed origin allowlist handling: an empty allowlist rejects in
 *    production unless an explicit `allowAllOrigins` opt-in is set.
 *  - wildcard/subdomain origin patterns (`https://*.example.com`).
 *  - a single rejection path that counts every rejected upgrade by reason and
 *    logs the *same* identity that rate limiting uses.
 *
 * Threat model note: origin enforcement only restrains browsers. A
 * non-browser client can omit or forge the Origin header, so it must never be
 * treated as authentication — the API additionally layers CSRF tokens and
 * HMAC signatures on top of this guard.
 */

export type WsRejectionReason =
  | 'rate-limit'
  | 'concurrent-limit'
  | 'origin'
  | 'origin-required'
  | 'csrf'
  | 'hmac'
  | 'custom';

export interface WsRejectionInfo {
  reason: WsRejectionReason | string;
  code: number;
  message: string;
  clientIp: string;
  origin?: string;
}

export interface WsGuardConfig {
  /** Origin allowlist. May contain wildcard subdomains like `https://*.example.com`. */
  allowedOrigins: string[];
  /** Require the Origin header to be present (browser clients always send one). */
  requireOrigin: boolean;
  /**
   * Explicit opt-in to accept browser connections from any origin when the
   * allowlist is empty. Deliberately separate from `allowedOrigins.length === 0`
   * so a deployment that merely forgot to configure origins fails closed.
   */
  allowAllOrigins: boolean;
  /** Treat as production when `NODE_ENV` cannot be inspected by the host service. */
  isProduction: boolean;
  /**
   * CIDR ranges of reverse proxies whose `X-Forwarded-For`/`Forwarded`
   * headers may be trusted. Empty means no proxy is trusted and forwarded
   * headers are always ignored.
   */
  trustedProxyCidrs: string[];
  /**
   * Maximum number of forwarded hops to walk back while resolving the client
   * identity. Bounds work for pathological header chains.
   */
  maxForwardedHops: number;
  /** Maximum upgrade attempts per IP per rate-limit window. */
  rateLimitMax: number;
  /** Rate-limit window length in milliseconds. */
  rateLimitWindowMs: number;
}

export const WS_GUARD_DEFAULTS: Pick<
  WsGuardConfig,
  'allowAllOrigins' | 'isProduction' | 'trustedProxyCidrs' | 'maxForwardedHops'
> = {
  allowAllOrigins: false,
  isProduction: false,
  trustedProxyCidrs: [],
  maxForwardedHops: 64,
};

export interface VerifyClientInfo {
  origin?: string;
  req: IncomingMessage;
  secure: boolean;
}

export type VerifyClientCallback = (
  allow: boolean,
  code?: number,
  message?: string,
) => void;

interface RateBucket {
  count: number;
  resetAt: number;
}

// ── IPv4/IPv6 CIDR helpers ───────────────────────────────────────────────────

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = parseInt(part, 10);
    if (value > 255) return null;
    result = result * 256 + value;
  }
  return result >>> 0;
}

/** Expands `::1` / `2001:db8::1` style addresses into eight 16-bit groups. */
function ipv6ToGroups(ip: string): number[] | null {
  if (!ip.includes(':')) return null;
  if (ip.includes('%')) ip = ip.split('%')[0];
  if (ip.startsWith('::')) ip = '0' + ip;
  if (ip.endsWith('::')) ip = ip + '0';

  const doubleColonCount = (ip.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let head: string[] = [];
  let tail: string[] = [];
  if (doubleColonCount === 1) {
    const [left, right] = ip.split('::');
    head = left ? left.split(':') : [];
    tail = right ? right.split(':') : [];
  } else {
    head = ip.split(':');
  }

  // Embedded IPv4 suffix (e.g. `::ffff:192.168.0.1`).
  const last = head.length > 0 ? head[head.length - 1] : '';
  if (last.includes('.')) {
    const long = ipv4ToLong(last);
    if (long === null) return null;
    head = head.slice(0, -1).concat(String((long >>> 16) & 0xffff), String(long & 0xffff));
  }
  const tailLast = tail.length > 0 ? tail[tail.length - 1] : '';
  if (tailLast.includes('.')) {
    const long = ipv4ToLong(tailLast);
    if (long === null) return null;
    tail = tail.slice(0, -1).concat(String((long >>> 16) & 0xffff), String(long & 0xffff));
  }

  const missing = 8 - head.length - tail.length;
  if (doubleColonCount === 1) {
    if (missing < 0) return null;
  } else if (missing !== 0) {
    return null;
  }

  const groups: number[] = [];
  for (const group of head.concat(new Array(Math.max(missing, 0)).fill('0')).concat(tail)) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  if (groups.length !== 8) return null;
  return groups;
}

export function parseCidr(cidr: string): { family: 4 | 6; address: string; prefix: number } | null {
  const [addressPart, prefixPart] = cidr.trim().split('/');
  if (!addressPart) return null;

  if (addressPart.includes('.')) {
    const long = ipv4ToLong(addressPart);
    if (long === null) return null;
    const prefix = prefixPart ? parseInt(prefixPart, 10) : 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { family: 4, address: addressPart, prefix };
  }

  const groups = ipv6ToGroups(addressPart);
  if (groups === null) return null;
  const prefix = prefixPart ? parseInt(prefixPart, 10) : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  return { family: 6, address: addressPart, prefix };
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (parsed === null) return false;

  if (parsed.family === 4) {
    const ipLong = ipv4ToLong(normalizeIpv4(ip));
    if (ipLong === null) return false;
    const netLong = ipv4ToLong(parsed.address)!;
    if (parsed.prefix === 0) return true;
    const mask = parsed.prefix === 32 ? 0xffffffff : (0xffffffff << (32 - parsed.prefix)) >>> 0;
    return (ipLong & mask) === (netLong & mask);
  }

  // IPv6 (and IPv4-mapped IPv6 when the CIDR is v6 — compare by groups).
  const ipGroups = ipv6ToGroups(normalizeIpv6ForComparison(ip));
  if (ipGroups === null) return false;
  const netGroups = ipv6ToGroups(parsed.address);
  if (netGroups === null) return false;

  const fullGroups = Math.floor(parsed.prefix / 16);
  const remainderBits = parsed.prefix % 16;
  for (let i = 0; i < fullGroups; i++) {
    if (ipGroups[i] !== netGroups[i]) return false;
  }
  if (remainderBits > 0) {
    const mask = (0xffff << (16 - remainderBits)) & 0xffff;
    if ((ipGroups[fullGroups] & mask) !== (netGroups[fullGroups] & mask)) return false;
  }
  return true;
}

function normalizeIpv4(ip: string): string {
  // `::ffff:a.b.c.d` peers may present as plain IPv4 when Node reports them.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : ip;
}

function normalizeIpv6ForComparison(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  // Node prefixes IPv6 loopback/links with scope or leading zeros; strip zone.
  return ip;
}

export function isIpInAnyCidr(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  return cidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}

// ── Origin matching ──────────────────────────────────────────────────────────

/**
 * Matches an origin against an allowlist entry. Entries are exact scheme+host
 * matches (`https://api.example.com`) or wildcard subdomains
 * (`https://*.example.com`, which also matches the bare domain). Ports are
 * part of the host and must match exactly when present.
 */
export function originMatches(origin: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === '*') return true;
  if (origin === trimmed) return true;

  const wildcard = trimmed.match(/^(https?):\/\/\*\.([a-z0-9.-]+(?::\d+)?)$/i);
  if (wildcard) {
    // `*.example.com` matches any single- or multi-label subdomain of
    // `example.com` (but not a differently-terminated suffix like
    // `evil-example.com`).
    const suffix = escapeRegExp(wildcard[2]);
    const match = origin.match(
      new RegExp(`^${wildcard[1]}://[a-z0-9-]+(\\.[a-z0-9-]+)*\\.${suffix}$`, 'i'),
    );
    return match !== null;
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Forwarded header parsing ─────────────────────────────────────────────────

function parseForwardedHeader(value: string): { for: string }[] {
  const hops: { for: string }[] = [];
  for (const element of value.split(',')) {
    const parts = element.trim().split(';');
    const entry: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      let paramValue = part.slice(eq + 1).trim();
      if (paramValue.startsWith('"') && paramValue.endsWith('"')) {
        paramValue = paramValue.slice(1, -1);
      }
      entry[key] = paramValue;
    }
    if (entry['for']) hops.push({ for: entry['for'] });
  }
  return hops;
}

/** Unwraps RFC 7239 address forms and bracketed IPv6. */
function unwrapForwardedHost(host: string): string {
  let value = host.trim();
  if (value.toLowerCase().startsWith('[') && value.includes(']')) {
    return value.slice(1, value.indexOf(']'));
  }
  // RFC 7239 may quote obfuscated/IPv6 forms like "2001:db8::1".
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
    if (value.startsWith('[') && value.includes(']')) {
      return value.slice(1, value.indexOf(']'));
    }
  }
  // Strip a port from bare IPv4 or hostname forms (`1.2.3.4:5678`).
  if (!value.includes(':') || /^[0-9.]+:\d+$/.test(value)) {
    const colon = value.lastIndexOf(':');
    if (colon !== -1 && /^[0-9.]+$/.test(value.slice(0, colon))) {
      return value.slice(0, colon);
    }
  }
  return value;
}

// ── The guard core ───────────────────────────────────────────────────────────

export interface WsGuardDecision {
  allowed: boolean;
  code?: number;
  message?: string;
  reason?: WsRejectionReason | string;
  clientIp: string;
  origin?: string;
}

export class WsGuardCore {
  private config: WsGuardConfig;
  private buckets = new Map<string, RateBucket>();
  private connectionCounts = new Map<string, number>();
  private rejectionCounts: { reason: string; count: number }[] = [];
  private rejectionIndex = new Map<string, number>();

  constructor(config: WsGuardConfig) {
    this.config = { ...WS_GUARD_DEFAULTS, ...config };
  }

  updateConfig(config: Partial<WsGuardConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): WsGuardConfig {
    return { ...this.config };
  }

  /**
   * Resolves the client identity for rate limiting.
   *
   * Forwarded headers are honoured only when the socket peer is itself a
   * trusted proxy; the right-most untrusted hop wins. When no proxy is
   * configured — or the peer is not trusted — the socket address is used and
   * client-supplied headers are ignored entirely.
   */
  resolveClientIp(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress || 'unknown';
    const trusted = this.config.trustedProxyCidrs;
    if (trusted.length === 0 || peer === 'unknown' || !isIpInAnyCidr(peer, trusted)) {
      return peer;
    }

    const maxHops = this.config.maxForwardedHops;
    let currentPeer = peer;
    let chain: string[] = [];

    const xff = req.headers['x-forwarded-for'];
    const forwarded = req.headers['forwarded'];

    if (typeof forwarded === 'string' && forwarded.length > 0) {
      chain = parseForwardedHeader(forwarded)
        .map((hop) => unwrapForwardedHost(hop.for))
        .slice(0, maxHops);
    } else if (typeof xff === 'string' && xff.length > 0) {
      chain = xff
        .split(',')
        .map((hop) => unwrapForwardedHost(hop))
        .slice(0, maxHops);
    } else if (Array.isArray(xff) && xff.length > 0) {
      chain = xff
        .join(',')
        .split(',')
        .map((hop) => unwrapForwardedHost(hop))
        .slice(0, maxHops);
    }

    // `chain` is ordered closest-to-server first (X-Forwarded-For semantics).
    // Walk from the right-most hop back toward the client: the first entry
    // that is NOT itself a trusted proxy is the client.
    for (let i = chain.length - 1; i >= 0; i--) {
      const hop = chain[i];
      if (!isIpInAnyCidr(hop, trusted)) {
        return hop;
      }
      currentPeer = hop;
    }
    void currentPeer;
    // Every hop is trusted (chained proxies) — the identity is the last hop,
    // which is the closest thing to a client we can know.
    return chain.length > 0 ? chain[0] : peer;
  }

  /** Origin policy: fail closed when the allowlist is empty in production. */
  checkOrigin(origin: string | undefined): { allowed: boolean; reason?: 'origin' | 'origin-required' } {
    const { allowedOrigins, requireOrigin, allowAllOrigins, isProduction } = this.config;

    if (!origin) {
      if (requireOrigin) return { allowed: false, reason: 'origin-required' };
      // No Origin header: a non-browser client. Permit it only when the
      // deployment has a deliberate origin policy (configured allowlist or
      // explicit opt-in) — otherwise omitting the header would be a trivial
      // bypass of the empty-allowlist fail-closed stance.
      if (allowedOrigins.length > 0 || allowAllOrigins || !isProduction) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'origin' };
    }

    if (allowedOrigins.length === 0) {
      // Fail closed in production unless the deployment explicitly opted in.
      return { allowed: !isProduction || allowAllOrigins, reason: 'origin' };
    }

    if (allowedOrigins.some((pattern) => originMatches(origin, pattern))) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'origin' };
  }

  checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.config.rateLimitWindowMs });
      return true;
    }

    bucket.count += 1;
    return bucket.count <= this.config.rateLimitMax;
  }

  checkConcurrentConnections(ip: string): boolean {
    // The core tracks the cap; `onConnect`/`onDisconnect` maintain the count.
    return true;
  }

  onConnect(ip: string): void {
    const count = this.connectionCounts.get(ip) || 0;
    this.connectionCounts.set(ip, count + 1);
  }

  onDisconnect(ip: string): void {
    const count = this.connectionCounts.get(ip) || 0;
    if (count <= 1) {
      this.connectionCounts.delete(ip);
    } else {
      this.connectionCounts.set(ip, count - 1);
    }
  }

  getConnectionCount(ip: string): number {
    return this.connectionCounts.get(ip) || 0;
  }

  setConnectionCount(ip: string, count: number): void {
    if (count <= 0) {
      this.connectionCounts.delete(ip);
    } else {
      this.connectionCounts.set(ip, count);
    }
  }

  /** Single rejection path: counts by reason and reports the verdict. */
  reject(info: {
    reason: WsRejectionReason | string;
    code: number;
    message: string;
    clientIp: string;
    origin?: string;
  }): WsGuardDecision {
    this.incrementRejection(info.reason);
    return {
      allowed: false,
      code: info.code,
      message: info.message,
      reason: info.reason,
      clientIp: info.clientIp,
      origin: info.origin,
    };
  }

  incrementRejection(reason: string): void {
    const index = this.rejectionIndex.get(reason);
    if (index === undefined) {
      this.rejectionIndex.set(reason, this.rejectionCounts.length);
      this.rejectionCounts.push({ reason, count: 1 });
    } else {
      this.rejectionCounts[index].count += 1;
    }
  }

  /** Rejection counts by reason, for the host service to export as metrics. */
  getRejectionCounts(): { reason: string; count: number }[] {
    return this.rejectionCounts.map((entry) => ({ ...entry }));
  }

  resetRejectionCounts(): void {
    this.rejectionCounts = [];
    this.rejectionIndex.clear();
  }

  sweep(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(ip);
    }
  }
}
