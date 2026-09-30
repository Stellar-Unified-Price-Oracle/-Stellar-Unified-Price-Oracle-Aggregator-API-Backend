import { logger } from '../observability/logger';
import { config } from './config';
import {
  WsGuardCore,
  type VerifyClientCallback,
  type VerifyClientInfo,
  type WsGuardConfig,
} from '@stellar-oracle/ws-guard';
import { wsUpgradeRejectionsTotal } from '../observability/metrics';

/**
 * Validates WebSocket upgrade requests for the aggregator broadcast server
 * (issue #40). Since #586 this is a thin wrapper around the shared
 * {@link WsGuardCore} from `@stellar-oracle/ws-guard`, which supplies
 * trusted-proxy-aware client identity, fail-closed origin handling and the
 * rejection-by-reason counter shared with the API guard.
 */

const SERVICE_LABEL = 'aggregator';

function guardConfigFromEnv(): WsGuardConfig {
  const ws = config.security.websocket;
  return {
    allowedOrigins: ws.allowedOrigins,
    requireOrigin: ws.requireOrigin,
    allowAllOrigins: process.env.WS_ALLOW_ALL_ORIGINS === 'true',
    isProduction: process.env.NODE_ENV === 'production',
    trustedProxyCidrs: commaList(process.env.WS_TRUSTED_PROXY_CIDRS),
    maxForwardedHops: parseInt(process.env.WS_MAX_FORWARDED_HOPS || '64', 10),
    rateLimitMax: ws.maxConnectionsPerWindow,
    rateLimitWindowMs: ws.rateLimitWindowMs,
  };
}

function commaList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export class WsConnectionGuard {
  private core = new WsGuardCore(guardConfigFromEnv());

  verifyClient = (
    info: VerifyClientInfo,
    cb: VerifyClientCallback,
  ): void => {
    const ip = this.core.resolveClientIp(info.req);
    const origin = info.origin;

    if (!this.core.checkRateLimit(ip)) {
      const decision = this.core.reject({
        reason: 'rate-limit',
        code: 429,
        message: 'Too many connection attempts',
        clientIp: ip,
        origin,
      });
      wsUpgradeRejectionsTotal.inc({ service: SERVICE_LABEL, reason: 'rate-limit' });
      logger.warn('[WS] Upgrade rejected — rate limit', {
        ip: decision.clientIp,
        origin: origin || '(none)',
      });
      cb(false, decision.code, decision.message);
      return;
    }

    const originCheck = this.core.checkOrigin(origin);
    if (!originCheck.allowed) {
      const decision = this.core.reject({
        reason: originCheck.reason ?? 'origin',
        code: 403,
        message: originCheck.reason === 'origin-required' ? 'Origin header required' : 'Origin not allowed',
        clientIp: ip,
        origin,
      });
      wsUpgradeRejectionsTotal.inc({ service: SERVICE_LABEL, reason: decision.reason ?? 'origin' });
      logger.warn('[WS] Upgrade rejected — origin', {
        ip: decision.clientIp,
        origin: origin || '(none)',
        reason: decision.reason,
      });
      cb(false, decision.code, decision.message);
      return;
    }

    cb(true);
  };

  sweep(): void {
    this.core.sweep();
  }
}
