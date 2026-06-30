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

/**
 * L1 TTL used when Redis is the primary distributed layer.
 * Keeps the L1 very short so cross-instance consistency is maintained via Redis
 * while still avoiding a round-trip on every request.
 */
const L1_TTL_WHEN_REDIS_ACTIVE_MS = 1000;
const INVALIDATION_CHANNEL = 'cache:invalidate';

export class HybridCache<T> {
  private redis: Redis | null = null;
  private subscriber: Redis | null = null;
  private useRedis: boolean = false;
  private readonly logger: Logger;
  private readonly defaultTtl: number;
  private readonly endpointTtls: Map<string, number>;
  /** L1 in-process cache. Short-lived when Redis is active; full-TTL fallback when Redis is down. */
  private l1: LRUCache<T>;

  constructor(logger: Logger, config: CacheConfig = {}) {
    this.logger = logger;
    this.defaultTtl = config.defaultTtl || 15000;
    this.l1 = new LRUCache<T>(1000, this.defaultTtl);

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
        retryStrategy: (times: number) => {
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
        // Switch L1 to a very short TTL so Redis is the consistent shared layer
        this.l1 = new LRUCache<T>(1000, L1_TTL_WHEN_REDIS_ACTIVE_MS);
        this.logger.info('Redis cache connected — L1 TTL set to 1s');
      });

      this.redis.on('error', (err: Error) => {
        this.logger.warn(`Redis error: ${err.message}, using LRU fallback`);
        this.useRedis = false;
        // Restore full-TTL L1 so the fallback provides reasonable coverage
        this.l1 = new LRUCache<T>(1000, this.defaultTtl);
      });

      this.redis.on('close', () => {
        this.useRedis = false;
        this.l1 = new LRUCache<T>(1000, this.defaultTtl);
        this.logger.info('Redis cache disconnected, using LRU fallback');
      });

      // Subscriber for cross-instance invalidation broadcasts
      this.subscriber = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        enableOfflineQueue: false,
      });
      this.subscriber.subscribe(INVALIDATION_CHANNEL, (err: Error | null) => {
        if (err) this.logger.warn(`Cache invalidation subscription failed: ${err.message}`);
      });
      this.subscriber.on('message', (_channel: string, pattern: string) => {
        this.l1.clear();
        this.logger.debug(`Cache invalidated via pub/sub for pattern "${pattern}"`);
      });
    } catch (err) {
      this.logger.warn(`Failed to initialize Redis: ${err}, using LRU fallback`);
      this.useRedis = false;
    }
  }

  async get(key: string): Promise<T | undefined> {
    // L1 hit — avoid Redis round-trip
    const l1Hit = this.l1.get(key);
    if (l1Hit !== undefined) return l1Hit;

    if (this.useRedis && this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          const value = JSON.parse(raw) as T;
          // Populate L1 so the next identical request within the short window is free
          this.l1.set(key, value);
          return value;
        }
      } catch (err) {
        this.logger.warn(`Redis get failed for key ${key}: ${err}`);
      }
    }
    return undefined;
  }

  async set(key: string, value: T, endpoint?: string): Promise<void> {
    const ttl = endpoint && this.endpointTtls.has(endpoint)
      ? this.endpointTtls.get(endpoint)!
      : this.defaultTtl;

    // Always populate L1 (either short-lived L1 when Redis active, or full-TTL fallback)
    this.l1.set(key, value);

    if (this.useRedis && this.redis) {
      try {
        await this.redis.setex(key, Math.ceil(ttl / 1000), JSON.stringify(value));
      } catch (err) {
        this.logger.warn(`Redis set failed for key ${key}: ${err}`);
      }
    }
  }

  async invalidate(pattern: string): Promise<void> {
    // Clear local L1 immediately
    this.l1.clear();

    if (this.useRedis && this.redis) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
        // Broadcast invalidation to all other instances via pub/sub
        await this.redis.publish(INVALIDATION_CHANNEL, pattern);
      } catch (err) {
        this.logger.warn(`Redis invalidation failed for pattern ${pattern}: ${err}`);
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.subscriber) await this.subscriber.quit();
    if (this.redis) await this.redis.quit();
  }

  isUsingRedis(): boolean {
    return this.useRedis;
  }
}
