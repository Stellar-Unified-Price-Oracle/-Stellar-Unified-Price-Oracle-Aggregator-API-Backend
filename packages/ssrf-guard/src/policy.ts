import net from 'net';
import { URL } from 'url';
import { SsrfError } from './errors';
import { isPrivateIp } from './ranges';

/**
 * Deployment policy: the per-environment egress allowlist. Loaded from
 * configuration (env vars / config file) so that provider and integration
 * destinations are constrained by the environment they run in, not by the
 * caller. See `loadDeploymentPolicy` for the supported shape.
 */
export interface DeploymentPolicy {
  /** Environment name this policy was loaded for (`production`, `staging`, ...). */
  environment: string;
  /** Exact lowercase hostnames permitted for egress. Empty means "deny all". */
  allowedHosts: string[];
  /** Optional hostname suffixes permitted for egress (e.g. `.example.com`). */
  allowedSuffixes?: string[];
  /** Require `https:` for every outbound URL. Defaults to true. */
  requireHttps?: boolean;
  /** Permit private / loopback / link-local / metadata addresses. Defaults to false. */
  allowPrivateIps?: boolean;
  /** Permit hostnames that can only name internal services. Defaults to false. */
  allowLocalHostnames?: boolean;
  /** Maximum number of redirect hops that will be re-validated. Defaults to 5. */
  maxRedirects?: number;
}

export interface SsrfPolicy {
  /**
   * Require `https:`. Callers that legitimately speak cleartext (the aggregator
   * talking to local test doubles) leave this false; anything that accepts
   * user-supplied URLs should set it.
   */
  requireHttps?: boolean;
  /**
   * Exact lowercase hostnames that may be contacted. An empty set means "any
   * host the other checks accept".
   */
  allowedHosts?: Iterable<string>;
  /** Permit private / loopback / link-local / metadata addresses. Default false. */
  allowPrivateIps?: boolean;
  /**
   * Permit hostnames that cannot be a public endpoint (`localhost`,
   * `*.internal`, in-cluster DNS, ...). Defaults to the value of
   * `allowPrivateIps`, because those hostnames only ever resolve privately.
   */
  allowLocalHostnames?: boolean;
}

const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'ip6-localhost',
  'ip6-loopback',
  'host.docker.internal',
  'host.containers.internal',
]);

const FORBIDDEN_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.cluster.local',
  '.svc',
];

/**
 * Hostnames that can only ever name an internal service. Checked statically so
 * a URL is rejected at registration time without spending a DNS query on it —
 * resolution itself is enforced later, at connect time, where it cannot be
 * raced with the request.
 */
export function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (FORBIDDEN_HOSTNAMES.has(host)) return true;
  return FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function normalizeHosts(hosts?: Iterable<string>): Set<string> {
  const out = new Set<string>();
  if (hosts) {
    for (const host of hosts) out.add(String(host).toLowerCase().replace(/\.$/, ''));
  }
  return out;
}

/**
 * Validate a raw outbound URL against a policy: protocol, optional HTTPS, host
 * allowlist, statically-forbidden hostnames, and (for IP literals) private-range
 * blocking. Throws {@link SsrfError} when the URL is not allowed.
 *
 * This is the cheap, DNS-free half of the guard. The other half is
 * {@link createSecureLookup}, which applies the same private-range rule to the
 * addresses the hostname actually resolves to, at socket-connection time.
 */
export function validateOutboundUrl(rawUrl: string, policy: SsrfPolicy = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('Malformed outbound URL', rawUrl, 'malformed-url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`Blocked protocol "${parsed.protocol}"`, rawUrl, 'protocol');
  }

  if (policy.requireHttps && parsed.protocol !== 'https:') {
    throw new SsrfError('HTTPS is required for outbound URLs', rawUrl, 'https-required');
  }

  // `new URL` keeps IPv6 literals bracketed (`[::1]`), which `net.isIP` cannot
  // parse, and preserves a trailing root dot (`foo.internal.`).
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const ipLiteral = host.replace(/^\[(.*)\]$/, '$1');
  const allow = normalizeHosts(policy.allowedHosts);
  if (allow.size > 0 && !allow.has(host)) {
    throw new SsrfError(`Host "${host}" is not in the allowlist`, rawUrl, 'allowlist');
  }

  const allowLocalHostnames = policy.allowLocalHostnames ?? policy.allowPrivateIps ?? false;
  if (!allowLocalHostnames && isForbiddenHostname(host)) {
    throw new SsrfError(`Host "${host}" names an internal service`, rawUrl, 'forbidden-host');
  }

  if (net.isIP(ipLiteral) && !policy.allowPrivateIps && isPrivateIp(ipLiteral)) {
    throw new SsrfError(`Host "${host}" is in a private range`, rawUrl, 'private-ip');
  }

  return parsed;
}

function normalizeSuffixes(suffixes?: Iterable<string>): string[] {
  const out: string[] = [];
  if (suffixes) {
    for (const suffix of suffixes) {
      const normalized = String(suffix).toLowerCase().replace(/\.$/, '');
      if (normalized) out.push(normalized.startsWith('.') ? normalized : `.${normalized}`);
    }
  }
  return out;
}

/**
 * Load a {@link DeploymentPolicy} for a named environment from a raw config
 * object (typically parsed from env vars or a config file). Fails closed: an
 * unknown environment or a missing allowlist throws rather than silently
 * permitting all egress.
 */
export function loadDeploymentPolicy(
  environment: string,
  config: Record<string, unknown>,
): DeploymentPolicy {
  const raw = config[environment];
  if (raw === undefined || raw === null) {
    throw new SsrfError(
      `No egress policy configured for environment "${environment}"`,
      environment,
      'policy-missing',
    );
  }
  if (typeof raw !== 'object') {
    throw new SsrfError(
      `Egress policy for environment "${environment}" is malformed`,
      environment,
      'policy-malformed',
    );
  }
  const entry = raw as Record<string, unknown>;
  const hosts = entry.allowedHosts;
  if (!Array.isArray(hosts)) {
    throw new SsrfError(
      `Egress policy for environment "${environment}" is missing allowedHosts`,
      environment,
      'policy-malformed',
    );
  }
  const allowedHosts = hosts.map((h) => String(h).toLowerCase().replace(/\.$/, ''));
  const allowedSuffixes = Array.isArray(entry.allowedSuffixes)
    ? entry.allowedSuffixes.map((s) => String(s))
    : undefined;
  return {
    environment,
    allowedHosts,
    allowedSuffixes,
    requireHttps: entry.requireHttps === undefined ? true : Boolean(entry.requireHttps),
    allowPrivateIps: Boolean(entry.allowPrivateIps),
    allowLocalHostnames: Boolean(entry.allowLocalHostnames),
    maxRedirects: typeof entry.maxRedirects === 'number' ? entry.maxRedirects : undefined,
  };
}

/**
 * Convert a {@link DeploymentPolicy} into the lower-level {@link SsrfPolicy}
 * consumed by {@link validateOutboundUrl}. Suffix entries are expanded into the
 * exact-host allowlist at validation time via {@link validateAgainstDeployment}.
 */
export function toSsrfPolicy(policy: DeploymentPolicy): SsrfPolicy {
  return {
    requireHttps: policy.requireHttps ?? true,
    allowedHosts: policy.allowedHosts,
    allowPrivateIps: policy.allowPrivateIps ?? false,
    allowLocalHostnames: policy.allowLocalHostnames ?? false,
  };
}

/**
 * Validate an outbound URL against a deployment policy, honouring both exact
 * hosts and permitted suffixes. Throws {@link SsrfError} when the destination
 * is not permitted by the environment's egress policy.
 */
export function validateAgainstDeployment(rawUrl: string, policy: DeploymentPolicy): URL {
  const parsed = validateOutboundUrl(rawUrl, {
    ...toSsrfPolicy(policy),
    // Suffix matching is applied below; the exact-host allowlist here would
    // otherwise reject a host that matches an allowed suffix.
    allowedHosts: undefined,
  });

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const exact = normalizeHosts(policy.allowedHosts);
  const suffixes = normalizeSuffixes(policy.allowedSuffixes);
  const suffixMatch = suffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
  if (!exact.has(host) && !suffixMatch) {
    throw new SsrfError(
      `Host "${host}" is not permitted by the "${policy.environment}" egress policy`,
      rawUrl,
      'deployment-allowlist',
    );
  }
  return parsed;
}

/**
 * A resolved destination pinned to the exact IP that was validated. Callers
 * must connect to `address` (not re-resolve `hostname`) so a DNS change between
 * validation and connection cannot redirect traffic to a blocked address.
 */
export interface PinnedDestination {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
}

/**
 * Resolve a hostname and pin it to a validated address. Every resolved address
 * is checked against the private-range rule; if any address is private the
 * destination is rejected (fail closed) rather than picking a "safe" one.
 */
export async function pinDestination(
  hostname: string,
  port: number,
  policy: SsrfPolicy = {},
  resolver: (host: string) => Promise<Array<{ address: string; family: number }>> = defaultResolve,
): Promise<PinnedDestination> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const ipLiteral = host.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(ipLiteral)) {
    if (!policy.allowPrivateIps && isPrivateIp(ipLiteral)) {
      throw new SsrfError(`Host "${host}" is in a private range`, hostname, 'private-ip');
    }
    return { hostname: host, address: ipLiteral, family: net.isIP(ipLiteral) as 4 | 6, port };
  }

  const addresses = await resolver(host);
  if (addresses.length === 0) {
    throw new SsrfError(`Host "${host}" did not resolve`, hostname, 'dns-empty');
  }
  for (const entry of addresses) {
    if (!policy.allowPrivateIps && isPrivateIp(entry.address)) {
      throw new SsrfError(
        `Host "${host}" resolves to a private address`,
        hostname,
        'private-ip',
      );
    }
  }
  const chosen = addresses[0];
  return {
    hostname: host,
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
    port,
  };
}

function defaultResolve(host: string): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    // Lazy require keeps `dns` out of the module's static import graph for
    // bundlers that tree-shake the guard into browser-adjacent code.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dns = require('dns') as typeof import('dns');
    dns.lookup(host, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/**
 * Follow a redirect chain, re-validating every hop against the deployment
 * policy and pinning each hop's destination. Returns the final pinned
 * destination. Throws {@link SsrfError} if any hop is disallowed or the chain
 * exceeds the policy's redirect budget.
 */
export async function validateRedirectChain(
  startUrl: string,
  policy: DeploymentPolicy,
  fetchRedirect: (url: string) => Promise<string | null>,
  resolver?: (host: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<{ url: URL; destination: PinnedDestination }> {
  const maxRedirects = policy.maxRedirects ?? 5;
  let current = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = validateAgainstDeployment(current, policy);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    const destination = await pinDestination(
      parsed.hostname,
      port,
      toSsrfPolicy(policy),
      resolver,
    );
    const next = await fetchRedirect(current);
    if (next === null) {
      return { url: parsed, destination };
    }
    current = next;
  }
  throw new SsrfError(
    `Redirect chain exceeded ${maxRedirects} hops`,
    startUrl,
    'redirect-limit',
  );
}
