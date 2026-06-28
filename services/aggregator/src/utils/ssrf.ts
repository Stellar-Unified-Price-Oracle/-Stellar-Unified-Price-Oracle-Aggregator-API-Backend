import http from 'http';
import https from 'https';
import net from 'net';
import dns from 'dns';
import { URL } from 'url';
import { logger } from './logger';
import { config } from '../config';

/**
 * SSRF protection for outbound HTTP requests to oracle sources.
 *
 * Provides:
 *  - Protocol enforcement (http/https only)
 *  - Host allowlisting (only configured oracle hosts may be contacted)
 *  - Internal / private IP range blocking
 *  - DNS rebinding mitigation (every resolved address used for the actual
 *    socket connection is re-validated via a custom lookup)
 *  - Structured logging of blocked attempts
 */

export class SsrfError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** CIDR-style ranges that must never be reachable from an outbound request. */
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata, e.g. 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function ipv4ToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function inV4Range(ip: string, range: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(range) & mask);
}

/**
 * Returns true if the given IP literal belongs to a private, loopback,
 * link-local, or otherwise non-routable range.
 */
export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);

  if (family === 4) {
    return BLOCKED_V4_RANGES.some(([range, bits]) => inV4Range(ip, range, bits));
  }

  if (family === 6) {
    const normalized = ip.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — validate the embedded v4 address.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);

    return (
      normalized === '::1' || // loopback
      normalized === '::' || // unspecified
      normalized.startsWith('fc') || // unique local fc00::/7
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80') || // link-local
      normalized.startsWith('ff') // multicast
    );
  }

  // Unknown / unparseable — treat as unsafe.
  return true;
}

/** Hosts that outbound oracle requests are permitted to reach. */
export function allowedHosts(): Set<string> {
  return new Set(config.security.ssrf.allowedHosts.map((h) => h.toLowerCase()));
}

/**
 * Validate a raw outbound URL: protocol, host allowlist, and (for IP literals)
 * private-range blocking. Throws {@link SsrfError} when the URL is not allowed.
 */
export function validateOutboundUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('Malformed outbound URL', rawUrl, 'malformed-url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`Blocked protocol "${parsed.protocol}"`, rawUrl, 'protocol');
  }

  const host = parsed.hostname.toLowerCase();
  const allow = allowedHosts();
  if (allow.size > 0 && !allow.has(host)) {
    throw new SsrfError(`Host "${host}" is not in the oracle allowlist`, rawUrl, 'allowlist');
  }

  // If the host is already an IP literal, validate it directly.
  if (net.isIP(host) && !config.security.ssrf.allowPrivateIps && isPrivateIp(host)) {
    throw new SsrfError(`Host "${host}" resolves to a private range`, rawUrl, 'private-ip');
  }

  return parsed;
}

/**
 * Custom DNS lookup used by the outbound agents. It resolves all addresses for
 * the hostname, re-validates them against the private-range blocklist, and only
 * hands a safe address to the socket. This closes the DNS-rebinding window where
 * a hostname passes allowlist checks but later resolves to an internal IP.
 *
 * The HTTP/HTTPS agents call this in single-address mode, so it always returns
 * one validated address.
 */
function secureLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }

    const list = addresses as dns.LookupAddress[];
    const safe = config.security.ssrf.allowPrivateIps
      ? list
      : list.filter((a) => !isPrivateIp(a.address));

    if (safe.length === 0) {
      logger.error('[SSRF] Blocked outbound request — DNS rebinding', {
        host: hostname,
        resolved: list.map((a) => a.address),
      });
      const blocked = new SsrfError(
        `All resolved addresses for "${hostname}" are private`,
        hostname,
        'dns-rebinding',
      ) as NodeJS.ErrnoException;
      callback(blocked, '', 0);
      return;
    }

    callback(null, safe[0].address, safe[0].family);
  });
}

let secureHttpAgent: http.Agent | null = null;
let secureHttpsAgent: https.Agent | null = null;

export function getSecureAgents(): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  if (!secureHttpAgent) {
    secureHttpAgent = new http.Agent({ lookup: secureLookup, keepAlive: true });
  }
  if (!secureHttpsAgent) {
    secureHttpsAgent = new https.Agent({ lookup: secureLookup, keepAlive: true });
  }
  return { httpAgent: secureHttpAgent, httpsAgent: secureHttpsAgent };
}
