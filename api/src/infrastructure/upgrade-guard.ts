import type { IncomingMessage } from 'http';
import { config } from './config';
import { logger } from '../observability/logger';
import { verifyWsCsrfToken, isCsrfEnabled } from './csrf';

/**
 * Validates WebSocket upgrade requests before a connection is accepted
 * (issue #40): origin allowlisting, per-IP connection rate limiting, and CSRF
 * token verification. Every rejected attempt is logged with the client IP.
 */

interface RateBucket {
  count: number;
  resetAt: number;
}

export class WsUpgradeGuard {
  private buckets = new Map<string, RateBucket>();

  /**
   * `verifyClient`-compatible callback for the `ws` server. Returns the
   * connection verdict via `cb(allow, code, message)`.
   */
  verifyClient = (
    info: { origin?: string; req: IncomingMessage; secure: boolean },
    cb: (allow: boolean, code?: number, message?: string) => void,
  ): void => {
    const ip = this.clientIp(info.req);
    const origin = info.origin;

    if (!this.checkRateLimit(ip)) {
      this.deny(ip, origin, 'rate-limit');
      cb(false, 429, 'Too many connection attempts');
      return;
    }

    if (!this.checkOrigin(origin)) {
      this.deny(ip, origin, 'origin');
      cb(false, 403, 'Origin not allowed');
      return;
    }

    if (!this.checkCsrf(info.req)) {
      this.deny(ip, origin, 'csrf');
      cb(false, 403, 'Invalid or missing CSRF token');
      return;
    }

    cb(true);
  };

  private checkOrigin(origin: string | undefined): boolean {
    const allowed = config.ws.allowedOrigins;

    if (!origin) {
      // No Origin header: non-browser clients. Allow only when not required.
      return !config.ws.requireOrigin;
    }

    // No allowlist configured → only enforce that an origin is present.
    if (allowed.length === 0) return true;

    return allowed.includes(origin);
  }

  private checkCsrf(req: IncomingMessage): boolean {
    if (!isCsrfEnabled()) return true;
    const token = this.queryParam(req, 'token');
    return verifyWsCsrfToken(token);
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + config.ws.rateLimitWindowMs });
      return true;
    }

    bucket.count += 1;
    return bucket.count <= config.ws.rateLimitMax;
  }

  private deny(ip: string, origin: string | undefined, reason: string): void {
    logger.warn('WS upgrade rejected', { ip, origin: origin || '(none)', reason });
  }

  private clientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  private queryParam(req: IncomingMessage, key: string): string | undefined {
    try {
      const url = new URL(req.url || '', 'http://localhost');
      return url.searchParams.get(key) || undefined;
    } catch {
      return undefined;
    }
  }

  /** Periodic cleanup of stale rate-limit buckets to bound memory. */
  sweep(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(ip);
    }
  }
}
