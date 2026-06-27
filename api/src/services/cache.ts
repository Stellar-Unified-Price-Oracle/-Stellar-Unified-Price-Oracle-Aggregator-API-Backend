import Redis from 'ioredis';
import { Logger } from 'winston';

export class LRUCache<T> {
  private cache: Map<string, { value: T; expiresAt: number }>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 1000, ttlMs = 15000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export interface CacheConfig {
  redisUrl?: string;
  fallbackToLru?: boolean;
  defaultTtl?: number;
  priceTtl?: number;
  historyTtl?: number;
  sourcesTtl?: number;
  healthTtl?: number;
}

export class HybridCache<T> {
  private redis: Redis | null = null;
  private lruFallback: LRUCache<T>;
  private useRedis: boolean = false;
  private readonly logger: Logger;
  private readonly defaultTtl: number;
  private readonly endpointTtls: Map<string, number>;

  constructor(logger: Logger, config: CacheConfig = {}) {
    this.logger = logger;
    this.defaultTtl = config.defaultTtl || 15000;
    this.lruFallback = new LRUCache<T>(1000, this.defaultTtl);

    this.endpointTtls = new Map([
      ['prices', config.priceTtl || 15000],
      ['price', config.priceTtl || 15000],
      ['history', config.historyTtl || 60000],
      ['sources', config.sourcesTtl || 300000],
      ['health', config.healthTtl || 30000],
    ]);

    if (config.redisUrl && config.fallbackToLru !== false) {
      this.initializeRedis(config.redisUrl);
    }
  }

  private initializeRedis(redisUrl: string): void {
    try {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        enableOfflineQueue: false,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.warn('Redis connection failed after 3 retries, falling back to LRU');
            this.useRedis = false;
            return null;
          }
          return Math.min(times * 50, 2000);
        },
      });

      this.redis.on('connect', () => {
        this.useRedis = true;
        this.logger.info('Redis cache connected');
      });

      this.redis.on('error', (err) => {
        this.logger.warn(`Redis error: ${err.message}, using LRU fallback`);
        this.useRedis = false;
      });

      this.redis.on('close', () => {
        this.useRedis = false;
        this.logger.info('Redis cache disconnected, using LRU fallback');
      });
    } catch (err) {
      this.logger.warn(`Failed to initialize Redis: ${err}, using LRU fallback`);
      this.useRedis = false;
    }
  }

  async get(key: string): Promise<T | undefined> {
    if (this.useRedis && this.redis) {
      try {
        const value = await this.redis.get(key);
        if (value) {
          return JSON.parse(value);
        }
      } catch (err) {
        this.logger.warn(`Redis get failed for key ${key}: ${err}`);
      }
    }
    return this.lruFallback.get(key);
  }

  async set(key: string, value: T, endpoint?: string): Promise<void> {
    const ttl = endpoint && this.endpointTtls.has(endpoint)
      ? this.endpointTtls.get(endpoint)!
      : this.defaultTtl;

    this.lruFallback.set(key, value);

    if (this.useRedis && this.redis) {
      try {
        const ttlSeconds = Math.ceil(ttl / 1000);
        await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
      } catch (err) {
        this.logger.warn(`Redis set failed for key ${key}: ${err}`);
      }
    }
  }

  async invalidate(pattern: string): Promise<void> {
    this.lruFallback.clear();

    if (this.useRedis && this.redis) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (err) {
        this.logger.warn(`Redis invalidation failed for pattern ${pattern}: ${err}`);
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  isUsingRedis(): boolean {
    return this.useRedis;
  }
}
