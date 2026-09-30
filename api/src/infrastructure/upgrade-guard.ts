import { logger } from '../observability/logger';
import { config } from './config';
import { verifyWsCsrfToken, isCsrfEnabled } from './csrf';
import { verifyWsSignature } from '../governance/ws-signing';
import {
  WsGuardCore,
  type VerifyClientCallback,
  type VerifyClientInfo,
  type WsGuardConfig,
} from '@stellar-oracle/ws-guard';
import { wsUpgradeRejectionsTotal } from '../observability/metrics';

/**
 * Validates WebSocket upgrade requests before a connection is accepted
 * (issue #40). Since #586 this is a thin wrapper around the shared
 * {@link WsGuardCore} from `@stellar-oracle/ws-guard`, so identity
 * resolution, origin policy and rejection accounting cannot diverge from the
 * aggregator guard. CSRF token and HMAC signature checks stay here because
 * they are API-specific (they need `WS_CSRF_SECRET` / `WS_HMAC_SECRET`).
 */

const SERVICE_LABEL = 'api';

function guardConfigFromEnv(): WsGuardConfig {
  return {
    allowedOrigins: config.ws.allowedOrigins,
    requireOrigin: config.ws.requireOrigin,
    allowAllOrigins: process.env.WS_ALLOW_ALL_ORIGINS === 'true',
    isProduction: process.env.NODE_ENV === 'production',
    trustedProxyCidrs: (process.env.WS_TRUSTED_PROXY_CIDRS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    maxForwardedHops: parseInt(process.env.WS_MAX_FORWARDED_HOPS || '64', 10),
    rateLimitMax: config.ws.rateLimitMax,
    rateLimitWindowMs: config.ws.rateLimitWindowMs,
  };
}

export class WsUpgradeGuard {
  private core = new WsGuardCore(guardConfigFromEnv());

  /**
   * `verifyClient`-compatible callback for the `ws` server. Returns the
   * connection verdict via `cb(allow, code, message)`.
   */
  verifyClient = (
    info: VerifyClientInfo,
    cb: VerifyClientCallback,
  ): void => {
    const ip = this.core.resolveClientIp(info.req);
    const origin = info.origin;

    if (!this.checkConcurrentConnections(ip)) {
      this.deny(ip, origin, 'concurrent-limit', 429, 'Too many concurrent connections from this IP');
      cb(false, 429, 'Too many concurrent connections from this IP');
      return;
    }

    if (!this.core.checkRateLimit(ip)) {
      this.deny(ip, origin, 'rate-limit', 429, 'Too many connection attempts');
      cb(false, 429, 'Too many connection attempts');
      return;
    }

    const originCheck = this.core.checkOrigin(origin);
    if (!originCheck.allowed) {
      this.deny(
        ip,
        origin,
        originCheck.reason ?? 'origin',
        403,
        originCheck.reason === 'origin-required' ? 'Origin header required' : 'Origin not allowed',
      );
      cb(false, 403, 'Origin not allowed');
      return;
    }

    if (!this.checkCsrf(info.req)) {
      this.deny(ip, origin, 'csrf', 403, 'Invalid or missing CSRF token');
      cb(false, 403, 'Invalid or missing CSRF token');
      return;
    }

    const sigCheck = verifyWsSignature(info.req, config.ws.hmacSecret);
    if (!sigCheck.valid) {
      this.deny(ip, origin, 'hmac', 403, sigCheck.error || 'Invalid WebSocket signature');
      cb(false, 403, sigCheck.error || 'Invalid WebSocket signature');
      return;
    }

    cb(true);
  };

  private checkCsrf(req: import('http').IncomingMessage): boolean {
    if (!isCsrfEnabled()) return true;
    const token = this.queryParam(req, 'token');
    return verifyWsCsrfToken(token);
  }

  onConnect(ip: string): void {
    this.core.onConnect(ip);
  }

  onDisconnect(ip: string): void {
    this.core.onDisconnect(ip);
  }

  getConnectionCount(ip: string): number {
    return this.core.getConnectionCount(ip);
  }

  /**
   * Client identity used by both rate limiting and logging, so abuse
   * attribution cannot be spoofed via forwarded headers (issue #586).
   */
  resolveClientIp(req: import('http').IncomingMessage): string {
    return this.core.resolveClientIp(req);
  }

  private checkConcurrentConnections(ip: string): boolean {
    return this.core.getConnectionCount(ip) < config.ws.maxConcurrentConnectionsPerIp;
  }

  private deny(
    ip: string,
    origin: string | undefined,
    reason: string,
    code: number,
    message: string,
  ): void {
    this.core.reject({ reason, code, message, clientIp: ip, origin });
    wsUpgradeRejectionsTotal.inc({ service: SERVICE_LABEL, reason });
    logger.warn('WS upgrade rejected', { ip, origin: origin || '(none)', reason });
  }

  private queryParam(req: import('http').IncomingMessage, key: string): string | undefined {
    try {
      const url = new URL(req.url || '', 'http://localhost');
      return url.searchParams.get(key) || undefined;
    } catch {
      return undefined;
    }
  }

  /** Periodic cleanup of stale rate-limit buckets to bound memory. */
  sweep(): void {
    this.core.sweep();
  }
}
