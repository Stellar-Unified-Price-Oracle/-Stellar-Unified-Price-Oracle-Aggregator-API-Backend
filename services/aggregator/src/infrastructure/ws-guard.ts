import type { IncomingMessage } from 'http';
import { config } from './config';
import { logger } from '../observability/logger';

/**
 * Validates WebSocket upgrade requests for the aggregator broadcast server
 * (issue #40): origin allowlisting and per-IP connection rate limiting, with
 * failed attempts logged including the client IP.
 */

interface RateBucket {
  count: number;
  resetAt: number;
}

export class WsConnectionGuard {
  private buckets = new Map<string, RateBucket>();

  verifyClient = (
    info: { origin?: string; req: IncomingMessage; secure: boolean },
    cb: (allow: boolean, code?: number, message?: string) => void,
  ): void => {
    const ip = this.clientIp(info.req);
    const origin = info.origin;
    const { websocket } = config.security;

    if (!this.checkRateLimit(ip)) {
      logger.warn('[WS] Upgrade rejected — rate limit', { ip, origin: origin || '(none)' });
      cb(false, 429, 'Too many connection attempts');
      return;
    }

    if (!this.checkOrigin(origin)) {
      logger.warn('[WS] Upgrade rejected — origin not allowed', { ip, origin: origin || '(none)' });
      cb(false, 403, 'Origin not allowed');
      return;
    }

    cb(true);
  };

  private checkOrigin(origin: string | undefined): boolean {
    const { allowedOrigins, requireOrigin } = config.security.websocket;
    if (!origin) return !requireOrigin;
    if (allowedOrigins.length === 0) return true;
    return allowedOrigins.includes(origin);
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const { maxConnectionsPerWindow, rateLimitWindowMs } = config.security.websocket;
    const bucket = this.buckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + rateLimitWindowMs });
      return true;
    }

    bucket.count += 1;
    return bucket.count <= maxConnectionsPerWindow;
  }

  private clientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  sweep(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(ip);
    }
  }
}
