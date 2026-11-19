import dns from 'dns';
import net from 'net';
import { URL } from 'url';
import { isPrivateIp } from './ranges';

export interface DeploymentPolicy {
  allowedHosts: string[];
  allowedSuffixes?: string[];
  allowedPorts?: number[];
  requireHttps?: boolean;
  allowPrivateIps?: boolean;
  maxRedirects?: number;
}

export type DestinationRejectReason =
  | 'malformed-url'
  | 'protocol'
  | 'insecure-protocol'
  | 'not-allowlisted'
  | 'port-not-allowed'
  | 'private-ip'
  | 'dns-rebinding'
  | 'dns-error'
  | 'redirect-limit';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface DestinationVerificationOptions {
  policy: DeploymentPolicy;
  redirectChain?: string[];
  previousAddresses?: ResolvedAddress[];
}

export interface DestinationVerificationResult {
  ok: boolean;
  url: string;
  host: string;
  port: number;
  addresses: ResolvedAddress[];
  reason?: DestinationRejectReason;
  blockedUrl?: string;
}

export interface DestinationVerificationFailure extends DestinationVerificationResult {
  ok: false;
  reason: DestinationRejectReason;
  blockedUrl: string;
}

interface Hop {
  raw: string;
  url: URL;
  host: string;
  port: number;
}

class Rejection {
  constructor(
    readonly reason: DestinationRejectReason,
    readonly hop: { raw: string; host: string; port: number },
  ) {}
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

function isAllowlisted(host: string, policy: DeploymentPolicy): boolean {
  if (policy.allowedHosts.some((h) => normalizeHost(h) === host)) return true;
  return (policy.allowedSuffixes ?? []).some((s) => {
    const suffix = normalizeHost(s).replace(/^\./, '');
    return suffix !== '' && (host === suffix || host.endsWith(`.${suffix}`));
  });
}

function checkHop(raw: string, policy: DeploymentPolicy): Hop {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Rejection('malformed-url', { raw, host: '', port: 0 });
  }
  const host = normalizeHost(url.hostname);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const hop = { raw, url, host, port };

  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Rejection('protocol', hop);
  if ((policy.requireHttps ?? true) && url.protocol !== 'https:') {
    throw new Rejection('insecure-protocol', hop);
  }
  if (net.isIP(host) && !policy.allowPrivateIps && isPrivateIp(host)) {
    throw new Rejection('private-ip', hop);
  }
  if (!isAllowlisted(host, policy)) throw new Rejection('not-allowlisted', hop);
  if (policy.allowedPorts && !policy.allowedPorts.includes(port)) {
    throw new Rejection('port-not-allowed', hop);
  }
  return hop;
}

function resolve(host: string): Promise<ResolvedAddress[]> {
  if (net.isIP(host)) return Promise.resolve([{ address: host, family: net.isIP(host) }]);
  return new Promise((resolvePromise, reject) => {
    dns.lookup(host, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolvePromise(addresses);
    });
  });
}

async function resolveHop(
  hop: Hop,
  policy: DeploymentPolicy,
  pinned: Set<string> | undefined,
): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(hop.host);
  } catch {
    throw new Rejection('dns-error', hop);
  }
  if (addresses.length === 0) throw new Rejection('dns-error', hop);
  if (pinned && addresses.some((a) => !pinned.has(a.address))) {
    throw new Rejection('dns-rebinding', hop);
  }
  if (!policy.allowPrivateIps && addresses.some((a) => isPrivateIp(a.address))) {
    throw new Rejection('private-ip', hop);
  }
  return addresses;
}

export async function verifyOutboundDestination(
  rawUrl: string,
  options: DestinationVerificationOptions,
): Promise<DestinationVerificationResult> {
  const { policy, previousAddresses } = options;
  const chain = options.redirectChain?.length ? [...options.redirectChain] : [rawUrl];
  if (chain[0] !== rawUrl) chain.unshift(rawUrl);

  try {
    const maxRedirects = policy.maxRedirects ?? 5;
    if (chain.length - 1 > maxRedirects) {
      throw new Rejection('redirect-limit', { raw: chain[chain.length - 1], host: '', port: 0 });
    }

    // Static checks run over the whole chain before any DNS lookup, so the
    // first disallowed hop is reported rather than a resolution side effect.
    const hops = chain.map((raw) => checkHop(raw, policy));
    const origin = hops[0].host;
    const pinned = previousAddresses?.length
      ? new Set(previousAddresses.map((a) => a.address))
      : undefined;

    let addresses: ResolvedAddress[] = [];
    for (const hop of hops) {
      addresses = await resolveHop(hop, policy, hop.host === origin ? pinned : undefined);
    }

    const final = hops[hops.length - 1];
    return { ok: true, url: hops[0].url.toString(), host: final.host, port: final.port, addresses };
  } catch (err) {
    if (!(err instanceof Rejection)) throw err;
    return {
      ok: false,
      url: rawUrl,
      host: err.hop.host,
      port: err.hop.port,
      addresses: [],
      reason: err.reason,
      blockedUrl: err.hop.raw,
    };
  }
}

export function verifyOutboundDestinations(
  rawUrls: string[],
  options: DestinationVerificationOptions,
): Promise<DestinationVerificationResult[]> {
  return Promise.all(rawUrls.map((url) => verifyOutboundDestination(url, options)));
}
