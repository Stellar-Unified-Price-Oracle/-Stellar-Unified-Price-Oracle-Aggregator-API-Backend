import crypto from 'crypto';
import { logger } from '../middleware/logger';

export interface ApiKeyMetadata {
  key: string;
  createdAt: number;
  lastUsed: number | null;
  requestCount: number;
  isActive: boolean;
  rateLimitPerMin: number;
  description?: string;
}

export interface ApiKeyStore {
  [key: string]: ApiKeyMetadata;
}

export class ApiKeyManager {
  private keys: Map<string, ApiKeyMetadata> = new Map();
  private lastMinuteRequests: Map<string, number[]> = new Map();

  constructor() {
    this.loadKeysFromEnv();
  }

  /**
   * Generate a new API key
   */
  generateKey(rateLimitPerMin: number = 100, description?: string): ApiKeyMetadata {
    const key = this.createKey();
    const metadata: ApiKeyMetadata = {
      key,
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      isActive: true,
      rateLimitPerMin,
      description,
    };

    this.keys.set(key, metadata);
    logger.info(`Generated new API key: ${key.substring(0, 8)}... (limit: ${rateLimitPerMin} req/min)`);

    return metadata;
  }

  /**
   * Validate an API key
   */
  validateKey(key: string): { valid: boolean; metadata?: ApiKeyMetadata; error?: string } {
    const metadata = this.keys.get(key);

    if (!metadata) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (!metadata.isActive) {
      return { valid: false, error: 'API key is inactive' };
    }

    return { valid: true, metadata };
  }

  /**
   * Check if key has exceeded rate limit
   */
  checkRateLimit(key: string): { allowed: boolean; remaining: number; resetTime: number } {
    const metadata = this.keys.get(key);
    if (!metadata) {
      return { allowed: false, remaining: 0, resetTime: 0 };
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Get or create request timestamps for this key
    let requests = this.lastMinuteRequests.get(key) || [];

    // Filter out requests older than 1 minute
    requests = requests.filter((timestamp) => timestamp > oneMinuteAgo);

    if (requests.length >= metadata.rateLimitPerMin) {
      // Find the reset time (when the oldest request expires)
      const oldestRequest = Math.min(...requests);
      const resetTime = oldestRequest + 60000;

      return { allowed: false, remaining: 0, resetTime };
    }

    // Add current request timestamp
    requests.push(now);
    this.lastMinuteRequests.set(key, requests);

    // Update metadata
    metadata.lastUsed = now;
    metadata.requestCount++;

    const remaining = metadata.rateLimitPerMin - requests.length;
    return { allowed: true, remaining, resetTime: 0 };
  }

  /**
   * Deactivate an API key
   */
  deactivateKey(key: string): boolean {
    const metadata = this.keys.get(key);
    if (!metadata) {
      return false;
    }

    metadata.isActive = false;
    logger.info(`Deactivated API key: ${key.substring(0, 8)}...`);

    return true;
  }

  /**
   * Reactivate an API key
   */
  reactivateKey(key: string): boolean {
    const metadata = this.keys.get(key);
    if (!metadata) {
      return false;
    }

    metadata.isActive = true;
    logger.info(`Reactivated API key: ${key.substring(0, 8)}...`);

    return true;
  }

  /**
   * Get key metadata
   */
  getKeyMetadata(key: string): ApiKeyMetadata | null {
    return this.keys.get(key) || null;
  }

  /**
   * Get all active keys (without exposing full keys)
   */
  getAllKeys(): Array<{ keyPrefix: string; createdAt: number; lastUsed: number | null; requestCount: number; isActive: boolean; rateLimitPerMin: number; description?: string }> {
    return Array.from(this.keys.values()).map((metadata) => ({
      keyPrefix: metadata.key.substring(0, 8) + '...',
      createdAt: metadata.createdAt,
      lastUsed: metadata.lastUsed,
      requestCount: metadata.requestCount,
      isActive: metadata.isActive,
      rateLimitPerMin: metadata.rateLimitPerMin,
      description: metadata.description,
    }));
  }

  /**
   * Update rate limit for a key
   */
  updateRateLimit(key: string, newLimit: number): boolean {
    const metadata = this.keys.get(key);
    if (!metadata) {
      return false;
    }

    metadata.rateLimitPerMin = newLimit;
    logger.info(`Updated rate limit for ${key.substring(0, 8)}... to ${newLimit} req/min`);

    return true;
  }

  /**
   * Delete an API key
   */
  deleteKey(key: string): boolean {
    const result = this.keys.delete(key);
    if (result) {
      this.lastMinuteRequests.delete(key);
      logger.info(`Deleted API key: ${key.substring(0, 8)}...`);
    }

    return result;
  }

  private createKey(): string {
    // Generate a secure random key: "sk_" + random bytes encoded as hex
    const randomBytes = crypto.randomBytes(32);
    return `sk_${randomBytes.toString('hex')}`;
  }

  private loadKeysFromEnv(): void {
    // Load keys from environment variable if provided
    const envKeys = process.env.API_KEYS;
    if (!envKeys) {
      // Create a default admin key if none exist
      if (this.keys.size === 0) {
        const adminKey = this.generateKey(10000, 'Default admin key');
        logger.info(`Generated default admin key: ${adminKey.key}`);
        logger.info('Store this key securely and use it for admin operations');
      }
      return;
    }

    try {
      // Expected format: key1:limit1:desc1,key2:limit2:desc2
      const keyConfigs = envKeys.split(',');
      for (const config of keyConfigs) {
        const parts = config.trim().split(':');
        if (parts.length >= 2) {
          const key = parts[0];
          const limit = parseInt(parts[1], 10);
          const description = parts[2];

          const metadata: ApiKeyMetadata = {
            key,
            createdAt: Date.now(),
            lastUsed: null,
            requestCount: 0,
            isActive: true,
            rateLimitPerMin: isNaN(limit) ? 100 : limit,
            description,
          };

          this.keys.set(key, metadata);
        }
      }

      logger.info(`Loaded ${this.keys.size} API keys from environment`);
    } catch (err) {
      logger.error('Failed to load API keys from environment', err);
    }
  }
}

// Global instance
export const apiKeyManager = new ApiKeyManager();
