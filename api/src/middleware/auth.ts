import { Request, Response, NextFunction } from 'express';
import { apiKeyManager } from '../services/api-key-manager';
import { logger } from './logger';

declare global {
  namespace Express {
    interface Request {
      apiKey?: string;
      rateLimitInfo?: {
        allowed: boolean;
        remaining: number;
        resetTime: number;
      };
    }
  }
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(req: Request): string | null {
  // Try Authorization header first: Bearer <key>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Try x-api-key header
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') {
    return apiKeyHeader;
  }

  return null;
}

/**
 * Authentication middleware
 * Validates API keys and enforces rate limiting
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: {
        code: 'MISSING_API_KEY',
        message: 'API key required. Use Authorization: Bearer <key> or x-api-key header',
      },
    });
    return;
  }

  // Validate API key
  const validation = apiKeyManager.validateKey(apiKey);
  if (!validation.valid) {
    logger.warn(`Invalid API key attempt: ${apiKey.substring(0, 8)}...`);
    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_API_KEY',
        message: validation.error || 'Invalid API key',
      },
    });
    return;
  }

  // Check rate limit
  const rateLimitInfo = apiKeyManager.checkRateLimit(apiKey);
  if (!rateLimitInfo.allowed) {
    const resetTime = new Date(rateLimitInfo.resetTime);
    logger.warn(`Rate limit exceeded for API key: ${apiKey.substring(0, 8)}...`);

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

  // Attach API key and rate limit info to request
  req.apiKey = apiKey;
  req.rateLimitInfo = rateLimitInfo;

  // Set rate limit headers
  res.set('X-RateLimit-Limit', validation.metadata?.rateLimitPerMin.toString() || '0');
  res.set('X-RateLimit-Remaining', rateLimitInfo.remaining.toString());
  if (rateLimitInfo.resetTime > 0) {
    res.set('X-RateLimit-Reset', Math.ceil(rateLimitInfo.resetTime / 1000).toString());
  }

  next();
}

/**
 * Admin key validation middleware
 * For endpoints that require an admin API key
 */
export function adminAuthMiddleware(adminKeyPrefix: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = extractApiKey(req);

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: {
          code: 'MISSING_API_KEY',
          message: 'Admin API key required',
        },
      });
      return;
    }

    // For now, we consider keys starting with specific prefix as admin keys
    // In production, you'd want a more robust system
    if (!apiKey.includes(adminKeyPrefix) && process.env.ADMIN_API_KEY !== apiKey) {
      logger.warn(`Unauthorized admin access attempt: ${apiKey.substring(0, 8)}...`);
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
    next();
  };
}

/**
 * Optional authentication middleware
 * Validates API key if provided, but doesn't require it
 */
export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    // No API key provided, continue without authentication
    next();
    return;
  }

  // Validate if key is provided
  const validation = apiKeyManager.validateKey(apiKey);
  if (!validation.valid) {
    logger.warn(`Invalid API key attempt: ${apiKey.substring(0, 8)}...`);
    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_API_KEY',
        message: validation.error || 'Invalid API key',
      },
    });
    return;
  }

  // Check rate limit
  const rateLimitInfo = apiKeyManager.checkRateLimit(apiKey);
  if (!rateLimitInfo.allowed) {
    const resetTime = new Date(rateLimitInfo.resetTime);
    logger.warn(`Rate limit exceeded for API key: ${apiKey.substring(0, 8)}...`);

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
  req.rateLimitInfo = rateLimitInfo;

  // Set rate limit headers
  res.set('X-RateLimit-Limit', validation.metadata?.rateLimitPerMin.toString() || '0');
  res.set('X-RateLimit-Remaining', rateLimitInfo.remaining.toString());

  next();
}
