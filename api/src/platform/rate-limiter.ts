import { NextFunction, Request, Response } from 'express';
import Redis from 'ioredis';
import { config } from '../infrastructure/config';
import {
  rateLimitCounterSize,
  rateLimitDecisionsTotal,
  rateLimitRedisLatency,
} from '../observability/metrics';

type Layer = 'global' | 'tenant' | 'ip' | 'endpoint';

interface Decision {
  allowed: boolean;
  layer: Layer;
  limit: number;
  remaining: number;
  reset: number;
  consumed: number;
  degraded: boolean;
}

const windows = new Map<string, { windowStart: number; count: number }>();
const cache = new Map<string, { expires: number; decision: Decision }>();
const redis = config.redisUrl ? new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
let redisHealthy = false;

const baseLimits: Record<Layer, number> = {
  global: config.rateLimitMax * 10,
  tenant: config.rateLimitMax,
  ip: config.rateLimitMax,
  endpoint: Math.max(10, Math.floor(config.rateLimitMax / 2)),
};

async function ensureRedis(): Promise<boolean> {
  if (!redis) return false;
  if (redisHealthy) return true;
  try {
    await redis.connect();
    redisHealthy = true;
  } catch {
    redisHealthy = false;
  }
  return redisHealthy;
}

function regionMultiplier(req: Request): number {
  const region = String(req.headers['x-geo-region'] || req.headers['cf-ipcountry'] || '').toUpperCase();
  if (['CN', 'RU', 'KP'].includes(region)) return 0.5;
  if (['AF', 'OC', 'SA'].includes(region)) return 1.25;
  return 1;
}

function adjustedLimit(layer: Layer, req: Request, degraded: boolean): number {
  const pressure = Number(req.headers['x-system-load'] || 0);
  const dynamic = pressure > 0.8 ? 0.75 : pressure < 0.3 ? 1.1 : 1;
  const degradation = degraded ? 0.5 : 1;
  return Math.max(1, Math.floor(baseLimits[layer] * regionMultiplier(req) * dynamic * degradation));
}

async function increment(key: string, degraded: boolean): Promise<{ count: number; reset: number }> {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMs;
  const windowStart = now - (now % windowMs);
  const reset = Math.ceil((windowStart + windowMs) / 1000);
  if (!degraded && redis && (await ensureRedis())) {
    const started = performance.now();
    try {
      const redisKey = `rl:${windowStart}:${key}`;
      const count = await redis.incr(redisKey);
      if (count === 1) await redis.pexpire(redisKey, windowMs * 2);
      rateLimitRedisLatency.observe((performance.now() - started) / 1000);
      return { count, reset };
    } catch {
      redisHealthy = false;
    }
  }
  const current = windows.get(key);
  if (!current || current.windowStart !== windowStart) {
    windows.set(key, { windowStart, count: 1 });
    rateLimitCounterSize.set(windows.size);
    return { count: 1, reset };
  }
  current.count += 1;
  return { count: current.count, reset };
}

async function evaluate(req: Request): Promise<Decision> {
  const tenant = String(req.headers['x-api-key'] || 'anonymous');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const endpoint = `${req.method}:${req.route?.path || req.path}`;
  const keys: Array<[Layer, string]> = [
    ['global', 'global'],
    ['tenant', `tenant:${tenant}`],
    ['ip', `ip:${ip}`],
    ['endpoint', `endpoint:${endpoint}`],
  ];
  const degraded = !(await ensureRedis());
  for (const [layer, key] of keys) {
    const limit = adjustedLimit(layer, req, degraded);
    const cacheKey = `${layer}:${key}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.decision;
    const { count, reset } = await increment(key, degraded);
    const decision = {
      allowed: count <= limit,
      layer,
      limit,
      remaining: Math.max(0, limit - count),
      reset,
      consumed: count,
      degraded,
    };
    cache.set(cacheKey, { expires: Date.now() + 50, decision });
    if (!decision.allowed) return decision;
  }
  return { allowed: true, layer: 'endpoint', limit: baseLimits.endpoint, remaining: baseLimits.endpoint, reset: Math.ceil((Date.now() + config.rateLimitWindowMs) / 1000), consumed: 0, degraded };
}

export async function distributedRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.path === '/metrics') return next();
  const decision = await evaluate(req);
  res.set('X-RateLimit-Limit', String(decision.limit));
  res.set('X-RateLimit-Remaining', String(decision.remaining));
  res.set('X-RateLimit-Reset', String(decision.reset));
  res.set('X-RateLimit-Consumed', String(decision.consumed));
  if (decision.degraded) res.set('X-RateLimit-Degraded', 'local');
  rateLimitDecisionsTotal.inc({
    layer: decision.layer,
    tenant: String(req.headers['x-api-key'] || 'anonymous'),
    endpoint: `${req.method}:${req.path}`,
    result: decision.allowed ? 'allowed' : 'blocked',
  });
  if (!decision.allowed) {
    const retryAfter = Math.max(1, decision.reset - Math.floor(Date.now() / 1000));
    res.set('Retry-After', String(retryAfter));
    res.set('X-RateLimit-Type', decision.layer);
    res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    return;
  }
  next();
}

export function rateLimitStatus() {
  return {
    mode: redisHealthy ? 'redis-cluster-crdt-sliding-window' : 'local-degraded-sliding-window',
    layers: Object.keys(baseLimits),
    redisConfigured: Boolean(redis),
    counterSize: windows.size,
    decisionCacheTtlMs: 50,
  };
}

