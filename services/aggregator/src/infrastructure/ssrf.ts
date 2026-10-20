import http from 'http';
import https from 'https';
import {
  SsrfError,
  createSecureLookup,
  isPrivateIp,
  validateOutboundUrl as validateWithPolicy,
  type SsrfPolicy,
} from '@stellar-oracle/ssrf-guard';
import {
  createEgressVerifier,
  type EgressVerifier,
  type VerifiedDestination,
} from '@stellar-oracle/egress-policy';
import { logger } from '../observability/logger';
import { config } from './config';

/**
 * SSRF protection for outbound HTTP requests to oracle sources.
 *
 * The checks themselves live in `@stellar-oracle/ssrf-guard` so the API's
 * user-controlled egress runs the same policy (issue #600) instead of a second
 * copy of the range tables. This module is the wiring: it binds that policy to
 * this service's config and logger, and builds the pooled agents.
 *
 * Provides:
 *  - Protocol enforcement (http/https only)
 *  - Host allowlisting (only configured oracle hosts may be contacted)
 *  - Internal / private IP range blocking
 *  - DNS rebinding mitigation (every resolved address used for the actual
 *    socket connection is re-validated via a custom lookup)
 *  - Deployment-policy verification of provider/integration egress, with IP
 *    pinning and redirect re-validation (issue #750)
 *  - Structured logging of blocked attempts
 *
 * The config object is read on each call rather than captured once: tests
 * `doMock` the config module before importing this one, and an operator's
 * config change should not be frozen out by a module-load-time snapshot.
 */

export { SsrfError, isPrivateIp };
export type { VerifiedDestination };

function currentPolicy(): SsrfPolicy {
  return {
    requireHttps: false,
    allowedHosts: config.security.ssrf.allowedHosts,
    allowPrivateIps: config.security.ssrf.allowPrivateIps,
    // The allowlist is this service's host control, and the lookup below still
    // refuses private resolutions, so local names stay permitted here.
    allowLocalHostnames: true,
  };
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
  return validateWithPolicy(rawUrl, currentPolicy());
}

function onBlocked(info: { host: string; addresses: string[] }): void {
  logger.error('[SSRF] Blocked outbound request — DNS rebinding', {
    host: info.host,
    resolved: info.addresses,
  });
}

let egressVerifier: EgressVerifier | null = null;

/**
 * Deployment-policy verifier for provider and integration egress.
 *
 * Built lazily from the live config so a policy change (allowlist, private-IP
 * relaxation, redirect budget) takes effect without a restart, matching the
 * rest of this module. The verifier pins the resolved IPs it validated so the
 * socket cannot be re-pointed by a later DNS answer, and re-validates every
 * redirect hop against the same policy.
 */
export function getEgressVerifier(): EgressVerifier {
  if (!egressVerifier) {
    egressVerifier = createEgressVerifier({
      getPolicy: currentPolicy,
      onBlocked: (info) => {
        logger.error('[SSRF] Blocked outbound request — deployment policy', {
          host: info.host,
          resolved: info.addresses,
          reason: info.reason,
        });
      },
    });
  }
  return egressVerifier;
}

/**
 * Verify an outbound provider/integration URL against the deployment policy.
 * Returns the pinned destination to connect to; throws {@link SsrfError} when
 * the URL, its resolution, or any redirect hop is not permitted.
 */
export async function verifyOutboundDestination(rawUrl: string): Promise<VerifiedDestination> {
  return getEgressVerifier().verify(rawUrl);
}

/**
 * Re-validate a redirect target against the deployment policy. Call this for
 * every `Location` header before following it so a permitted host cannot
 * redirect egress to a blocked destination.
 */
export async function verifyRedirect(
  fromUrl: string,
  location: string,
): Promise<VerifiedDestination> {
  return getEgressVerifier().verifyRedirect(fromUrl, location);
}

let secureHttpAgent: http.Agent | null = null;
let secureHttpsAgent: https.Agent | null = null;
let secureLookup: ReturnType<typeof createSecureLookup> | null = null;

export function getSecureAgents(): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  if (!secureLookup) {
    secureLookup = createSecureLookup({ getPolicy: currentPolicy, onBlocked });
  }
  if (!secureHttpAgent) {
    secureHttpAgent = new http.Agent({
      lookup: secureLookup,
      // Pin the verified address for the connection so a second DNS answer
      // cannot redirect the socket after policy verification.
      servername: undefined,
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 30_000,
    });
  }
  if (!secureHttpsAgent) {
    secureHttpsAgent = new https.Agent({
      lookup: secureLookup,
      // Pin the verified address for the connection so a second DNS answer
      // cannot redirect the socket after policy verification.
      servername: undefined,
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 30_000,
    });
  }
  return { httpAgent: secureHttpAgent, httpsAgent: secureHttpsAgent };
}
