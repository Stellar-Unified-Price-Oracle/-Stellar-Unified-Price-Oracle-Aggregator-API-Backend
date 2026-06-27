import { Request, Response, NextFunction } from 'express';
import { apiKeyManager } from '../services/api-key-manager';
import { logger } from './logger';
import { auditLog } from '../services/audit-logger';
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
      };
    }
  }
}

export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') {
    return apiKeyHeader;
  }

  return null;
}

function requestContext(req: Request) {
  return {
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: (req.headers['user-agent'] as string) || 'unknown',
  };
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
        message: 'API key required. Use Authorization: Bearer <key> or x-api-key header',
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
    const resetTime = new Date(rateLimitInfo.resetTime);
    logger.warn(`Rate limit exceeded for API key: ${apiKey.substring(0, 8)}...`);
    auditLog('auth.rate_limited', {
      ...ctx,
      apiKeyPrefix: apiKey.substring(0, 8),
      details: { path: req.path, resetTime: resetTime.toISOString() },
    });

    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'API rate limit exceeded',
        resetTime: resetTime.toISOString(),
      },
    });
    return;
  }

  req.apiKey = apiKey;
  req.userRole = validation.metadata?.role || 'viewer';
  req.rateLimitInfo = rateLimitInfo;

  auditLog('auth.success', {
    ...ctx,
    apiKeyPrefix: apiKey.substring(0, 8),
    details: { path: req.path, role: req.userRole },
  });

  res.set('X-RateLimit-Limit', validation.metadata?.rateLimitPerMin.toString() || '0');
  res.set('X-RateLimit-Remaining', rateLimitInfo.remaining.toString());
  if (rateLimitInfo.resetTime > 0) {
    res.set('X-RateLimit-Reset', Math.ceil(rateLimitInfo.resetTime / 1000).toString());
  }

  next();
}

export function adminAuthMiddleware(adminKeyPrefix: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = extractApiKey(req);
    const ctx = requestContext(req);

    if (!apiKey) {
      auditLog('auth.failure', { ...ctx, details: { reason: 'MISSING_ADMIN_KEY', path: req.path } });
      res.status(401).json({
        success: false,
        error: {
          code: 'MISSING_API_KEY',
          message: 'Admin API key required',
        },
      });
      return;
    }

    // Accept keys with admin prefix or the env ADMIN_API_KEY, or keys with admin role
    const validation = apiKeyManager.validateKey(apiKey);
    const hasAdminRole = validation.valid && validation.metadata?.role === 'admin';
    const isLegacyAdmin = apiKey.includes(adminKeyPrefix) || process.env.ADMIN_API_KEY === apiKey;

    if (!hasAdminRole && !isLegacyAdmin) {
      logger.warn(`Unauthorized admin access attempt: ${apiKey.substring(0, 8)}...`);
      auditLog('auth.failure', {
        ...ctx,
        apiKeyPrefix: apiKey.substring(0, 8),
        details: { reason: 'FORBIDDEN_ADMIN', path: req.path },
      });
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'This operation requires admin privileges',
        },
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
    const resetTime = new Date(rateLimitInfo.resetTime);
    logger.warn(`Rate limit exceeded for API key: ${apiKey.substring(0, 8)}...`);
    auditLog('auth.rate_limited', {
      ...ctx,
      apiKeyPrefix: apiKey.substring(0, 8),
      details: { path: req.path, resetTime: resetTime.toISOString() },
    });

    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'API rate limit exceeded',
        resetTime: resetTime.toISOString(),
      },
    });
    return;
  }

  req.apiKey = apiKey;
  req.userRole = validation.metadata?.role || 'viewer';
  req.rateLimitInfo = rateLimitInfo;

  res.set('X-RateLimit-Limit', validation.metadata?.rateLimitPerMin.toString() || '0');
  res.set('X-RateLimit-Remaining', rateLimitInfo.remaining.toString());

  next();
}
