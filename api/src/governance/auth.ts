import { Request, Response, NextFunction } from 'express';
import { IncomingMessage } from 'http';
import { apiKeyManager } from './api-key-manager';
import { logger } from '../observability/logger';
import { auditLog } from './audit-logger';
import type { Role } from './rbac';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: string;
      userRole?: Role;
      rateLimitInfo?: {
        allowed: boolean;
        remaining: number;
        resetTime: number;
        retryAfter?: number;
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

function applyRateLimitHeaders(res: Response, rateLimitPerMin: number, remaining: number, resetTime: number): void {
  res.set('X-RateLimit-Limit', rateLimitPerMin.toString());
  res.set('X-RateLimit-Remaining', remaining.toString());
  res.set('X-RateLimit-Reset', Math.ceil(resetTime / 1000).toString());
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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

  const validation = apiKeyManager.validateKey(apiKey);
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

  const rateLimitInfo = apiKeyManager.checkRateLimit(apiKey);
  if (!rateLimitInfo.allowed) {
    logger.warn(`Rate limit exceeded for API key: ${apiKey.substring(0, 8)}...`);
    res.set('Retry-After', String(rateLimitInfo.retryAfter ?? 60));
    applyRateLimitHeaders(res, validation.metadata!.rateLimitPerMin, 0, rateLimitInfo.resetTime);
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
  applyRateLimitHeaders(res, validation.metadata!.rateLimitPerMin, rateLimitInfo.remaining, rateLimitInfo.resetTime);

  next();
}

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

    const isAdmin = apiKeyManager.isAdminKey(apiKey) || process.env.ADMIN_API_KEY === apiKey;
    if (!isAdmin) {
      logger.warn(`Unauthorized admin access: ${apiKey.substring(0, 8)}...`);
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'This operation requires admin privileges.' },
      });
      return;
    }

    req.apiKey = apiKey;
    req.userRole = 'admin';
    next();
  };
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = extractApiKey(req);
  const ctx = requestContext(req);

  if (!apiKey) {
    next();
    return;
  }

  const validation = apiKeyManager.validateKey(apiKey);
  if (!validation.valid) {
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_API_KEY', message: validation.error || 'Invalid API key' },
    });
    return;
  }

  const rateLimitInfo = apiKeyManager.checkRateLimit(apiKey);
  if (!rateLimitInfo.allowed) {
    res.set('Retry-After', String(rateLimitInfo.retryAfter ?? 60));
    applyRateLimitHeaders(res, validation.metadata!.rateLimitPerMin, 0, rateLimitInfo.resetTime);
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
  applyRateLimitHeaders(res, validation.metadata!.rateLimitPerMin, rateLimitInfo.remaining, rateLimitInfo.resetTime);

  next();
}

export function validateWebSocketApiKey(req: IncomingMessage): { valid: boolean; error?: string } {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    return { valid: false, error: 'API key required for WebSocket connections' };
  }

  const validation = apiKeyManager.validateKey(apiKey);
  if (!validation.valid) {
    return { valid: false, error: validation.error || 'Invalid API key' };
  }

  return { valid: true };
}
