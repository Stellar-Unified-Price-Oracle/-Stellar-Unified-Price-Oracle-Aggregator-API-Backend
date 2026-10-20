import { Request, Response, NextFunction } from 'express';
import { IncomingMessage } from 'http';
import { apiKeyManager, type ApiKeyManager } from './api-key-manager';
import { logger } from '../observability/logger';
import { auditLog } from './audit-logger';
import type { Role } from './rbac';
import { isRole, denyAuthorization } from './rbac';
import { decryptSecret } from './crypto';
import {
  resolveCredentialPolicy,
  enforceCredentialPolicy,
  type CredentialPolicy,
  type PolicyContext,
} from './credential-policy';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: string;
      userRole?: Role;
      /** Resolved policy scopes for the presented credential (null when unscoped). */
      credentialPolicy?: CredentialPolicy | null;
      rateLimitInfo?: {
        allowed: boolean;
        remaining: number;
        resetTime: number;
        retryAfter?: number;
        /** The effective tenant allowance that was enforced (limit model). */
        limit: number;
        degraded?: boolean;
      };
    }
  }
}

function requestContext(req: Request) {
  return {
    ip: req.ip,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
  };
}

/**
 * Builds the policy evaluation context for a request. The operation is derived
 * from the HTTP method (read vs write) and the feed/environment from the
 * request path and headers so every API surface is evaluated consistently.
 */
function policyContext(req: Request): PolicyContext {
  const method = req.method.toUpperCase();
  const operation = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write';
  const envHeader = req.headers['x-environment'];
  const environment = typeof envHeader === 'string' ? envHeader : undefined;
  return {
    operation,
    method,
    path: req.path,
    environment,
  };
}

/**
 * Enforces the credential's policy scopes (expiry, environment, operation,
 * feed) against the request. Returns true when the request may proceed; when
 * false a 403 with a specific error code has already been written.
 */
function enforcePolicy(
  req: Request,
  res: Response,
  apiKey: string,
  metadata: { scopes?: string[]; policy?: unknown } | undefined,
): boolean {
  const policy = resolveCredentialPolicy(metadata);
  req.credentialPolicy = policy;
  if (!policy) return true;

  const decision = enforceCredentialPolicy(policy, policyContext(req));
  if (decision.allowed) return true;

  const ctx = requestContext(req);
  logger.warn(`Credential policy denied request: ${apiKey.substring(0, 8)}... (${decision.code})`);
  auditLog('auth.failure', {
    ...ctx,
    apiKeyPrefix: apiKey.substring(0, 8),
    details: { reason: decision.code, path: req.path, operation: policyContext(req).operation },
  });
  res.status(403).json({
    success: false,
    error: {
      code: decision.code,
      message: decision.message,
    },
  });
  return false;
}

export function extractApiKey(req: Request | IncomingMessage): string | null {
  const headers = req.headers;

  const authHeader = headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const apiKeyHeader = headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') {
    return apiKeyHeader;
  }

  return null;
}

function applyRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetTime: number,
  degraded?: boolean,
): void {
  res.set('X-RateLimit-Limit', limit.toString());
  res.set('X-RateLimit-Remaining', remaining.toString());
  res.set('X-RateLimit-Reset', Math.ceil(resetTime / 1000).toString());
  res.set('X-RateLimit-Consumed', Math.max(0, limit - remaining).toString());
  if (degraded) res.set('X-RateLimit-Degraded', 'local');
  else res.removeHeader('X-RateLimit-Degraded');
}

export interface AuthDependencies {
  manager?: ApiKeyManager;
}

/**
 * The authoritative rate-limit enforcement point: every authenticated request
 * consumes one slot from the shared tenant window using the effective limit
 * from `platform/limit-model.ts`, and `X-RateLimit-Limit` reports exactly that
 * number. `manager` is injectable so tests can model multiple replicas.
 */
export function createAuthMiddleware(deps: AuthDependencies = {}) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const manager = deps.manager ?? apiKeyManager;
      const apiKey = extractApiKey(req);
      const ctx = requestContext(req);

      if (!apiKey) {
        auditLog('auth.failure', { ...ctx, details: { reason: 'MISSING_API_KEY', path: req.path } });
        res.status(401).json({
          success: false,
          error: {
            code: 'MISSING_API_KEY',
            message: 'API key required. Use Authorization: Bearer <key> or X-Api-Key header.',
          },
        });
        return;
      }

      const validation = manager.validateKey(apiKey);
      if (!validation.valid) {
        logger.warn(`Invalid API key attempt: ${apiKey.substring(0, 8)}...`);
        auditLog('auth.failure', {
          ...ctx,
          apiKeyPrefix: apiKey.substring(0, 8),
          details: { reason: 'INVALID_API_KEY', path: req.path },
        });
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_API_KEY',
            message: validation.error || 'Invalid API key',
          },
        });
        return;
      }

      if (!enforcePolicy(req, res, apiKey, validation.metadata)) {
        return;
      }

      const rateLimitInfo = await manager.checkRateLimit(apiKey);
      if (!rateLimitInfo.allowed) {
        logger.warn(`Rate limit exceeded for API key: ${apiKey.substring(0, 8)}...`);
        res.set('Retry-After', String(rateLimitInfo.retryAfter ?? 60));
        applyRateLimitHeaders(res, rateLimitInfo.limit, 0, rateLimitInfo.resetTime, rateLimitInfo.degraded);
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded. Retry after ${rateLimitInfo.retryAfter ?? 60} seconds.`,
            retryAfter: rateLimitInfo.retryAfter,
            resetTime: new Date(rateLimitInfo.resetTime).toISOString(),
          },
        });
        return;
      }

      req.apiKey = apiKey;
      req.userRole = validation.metadata?.role || 'viewer';
      req.rateLimitInfo = rateLimitInfo;
      applyRateLimitHeaders(res, rateLimitInfo.limit, rateLimitInfo.remaining, rateLimitInfo.resetTime, rateLimitInfo.degraded);

      next();
    } catch (err) {
      next(err);
    }
  };
}

export const authMiddleware = createAuthMiddleware();

export function adminAuthMiddleware(_adminKeyPrefix: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = extractApiKey(req);
    const ctx = requestContext(req);

    if (!apiKey) {
      auditLog('auth.failure', { ...ctx, details: { reason: 'MISSING_ADMIN_KEY', path: req.path } });
      res.status(401).json({
        success: false,
        error: { code: 'MISSING_API_KEY', message: 'Admin API key required.' },
      });
      return;
    }

    const validation = apiKeyManager.validateKey(apiKey);
    if (!validation.valid) {
      logger.warn(`Invalid admin key attempt: ${apiKey.substring(0, 8)}...`);
      res.status(401).json({
        success: false,
        error: { code: 'INVALID_API_KEY', message: validation.error || 'Invalid API key' },
      });
      return;
    }

    const metadata = validation.metadata!;
    const adminApiKey = process.env.ADMIN_API_KEY ? decryptSecret(process.env.ADMIN_API_KEY) : '';
    const role: Role = adminApiKey && adminApiKey === apiKey ? 'admin' : metadata.role;

    if (!isRole(role)) {
      denyAuthorization(req, res, 'unknown_role', 'API key has an unknown role and cannot be authorized');
      return;
    }

    if (!enforcePolicy(req, res, apiKey, metadata)) {
      return;
    }

    req.apiKey = apiKey;
    req.userRole = role;
    req.apiKeyScopes = metadata.scopes;
    next();
  };
}

export function createOptionalAuthMiddleware(deps: AuthDependencies = {}) {
  return async function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const manager = deps.manager ?? apiKeyManager;
      const apiKey = extractApiKey(req);

      if (!apiKey) {
        next();
        return;
      }

      const validation = manager.validateKey(apiKey);
      if (!validation.valid) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_API_KEY', message: validation.error || 'Invalid API key' },
        });
        return;
      }

      if (!enforcePolicy(req, res, apiKey, validation.metadata)) {
        return;
      }

      const rateLimitInfo = await manager.checkRateLimit(apiKey);
      if (!rateLimitInfo.allowed) {
        res.set('Retry-After', String(rateLimitInfo.retryAfter ?? 60));
        applyRateLimitHeaders(res, rateLimitInfo.limit, 0, rateLimitInfo.resetTime, rateLimitInfo.degraded);
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded. Retry after ${rateLimitInfo.retryAfter ?? 60} seconds.`,
            retryAfter: rateLimitInfo.retryAfter,
          },
        });
        return;
      }

      req.apiKey = apiKey;
      req.userRole = validation.metadata?.role || 'viewer';
      req.rateLimitInfo = rateLimitInfo;
      applyRateLimitHeaders(res, rateLimitInfo.limit, rateLimitInfo.remaining, rateLimitInfo.resetTime, rateLimitInfo.degraded);

      next();
    } catch (err) {
      next(err);
    }
  };
}

export const optionalAuthMiddleware = createOptionalAuthMiddleware();

export function validateWebSocketApiKey(req: IncomingMessage): { valid: boolean; error?: string; code?: string } {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    return { valid: false, error: 'API key required for WebSocket connections', code: 'MISSING_API_KEY' };
  }

  const validation = apiKeyManager.validateKey(apiKey);
  if (!validation.valid) {
    return { valid: false, error: validation.error || 'Invalid API key', code: 'INVALID_API_KEY' };
  }

  const policy = resolveCredentialPolicy(validation.metadata);
  if (policy) {
    const decision = enforceCredentialPolicy(policy, {
      operation: 'read',
      method: 'GET',
      path: typeof req.url === 'string' ? req.url : '/',
      environment: typeof req.headers['x-environment'] === 'string' ? req.headers['x-environment'] : undefined,
    });
    if (!decision.allowed) {
      return { valid: false, error: decision.message, code: decision.code };
    }
  }

  return { valid: true };
}
