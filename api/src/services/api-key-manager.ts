import crypto from 'crypto';
import { logger } from '../middleware/logger';
import type { Role } from '../middleware/rbac';

export interface ApiKeyMetadata {
  key: string;
  createdAt: number;
  lastUsed: number | null;
  requestCount: number;
  isActive: boolean;
  rateLimitPerMin: number;
  description?: string;
  role: Role;
  /** If set, this key is in rotation grace period until this timestamp */
  rotationExpiresAt?: number;
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
  generateKey(rateLimitPerMin: number = 100, description?: string, role: Role = 'viewer'): ApiKeyMetadata {
    const key = this.createKey();
    const metadata: ApiKeyMetadata = {
      key,
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      isActive: true,
      rateLimitPerMin,
      description,
      role,
    };

    this.keys.set(key, metadata);
    logger.info(`Generated new API key: ${key.substring(0, 8)}... (limit: ${rateLimitPerMin} req/min, role: ${role})`);

    return metadata;
  }

  /**
   * Rotate a key: create a new key and keep old one alive for gracePeriodMs.
   * Returns the new key metadata.
   */
  rotateKey(oldKey: string, gracePeriodMs = 24 * 60 * 60 * 1000): ApiKeyMetadata | null {
    const oldMeta = this.keys.get(oldKey);
    if (!oldMeta || !oldMeta.isActive) return null;

    const newMeta = this.generateKey(oldMeta.rateLimitPerMin, oldMeta.description, oldMeta.role);

    // Keep old key valid during grace period
    oldMeta.rotationExpiresAt = Date.now() + gracePeriodMs;

    logger.info(
      `Rotating key ${oldKey.substring(0, 8)}... → ${newMeta.key.substring(0, 8)}... grace period: ${gracePeriodMs}ms`,
    );

    return newMeta;
  }

  /**
   * Validate an API key — also accepts keys in grace-period rotation
   */
  validateKey(key: string): { valid: boolean; metadata?: ApiKeyMetadata; error?: string } {
    const metadata = this.keys.get(key);

    if (!metadata) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (!metadata.isActive) {
      // Accept during rotation grace period
      if (metadata.rotationExpiresAt && Date.now() < metadata.rotationExpiresAt) {
        return { valid: true, metadata };
      }
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

    let requests = this.lastMinuteRequests.get(key) || [];
    requests = requests.filter((timestamp) => timestamp > oneMinuteAgo);

    if (requests.length >= metadata.rateLimitPerMin) {
      const oldestRequest = Math.min(...requests);
      const resetTime = oldestRequest + 60000;
      return { allowed: false, remaining: 0, resetTime };
    }

    requests.push(now);
    this.lastMinuteRequests.set(key, requests);

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
    if (!metadata) return false;

    metadata.isActive = false;
    delete metadata.rotationExpiresAt;
    logger.info(`Deactivated API key: ${key.substring(0, 8)}...`);

    return true;
  }

  /**
   * Reactivate an API key
   */
  reactivateKey(key: string): boolean {
    const metadata = this.keys.get(key);
    if (!metadata) return false;

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
   * Find full key by prefix (first 8 chars)
   */
  findKeyByPrefix(prefix: string): string | null {
    for (const [key] of this.keys) {
      if (key.startsWith(prefix)) return key;
    }
    return null;
  }

  /**
   * Get all keys (without exposing full keys)
   */
  getAllKeys(): Array<{
    keyPrefix: string;
    createdAt: number;
    lastUsed: number | null;
    requestCount: number;
    isActive: boolean;
    rateLimitPerMin: number;
    description?: string;
    role: Role;
    rotating: boolean;
  }> {
    return Array.from(this.keys.values()).map((metadata) => ({
      keyPrefix: metadata.key.substring(0, 8) + '...',
      createdAt: metadata.createdAt,
      lastUsed: metadata.lastUsed,
      requestCount: metadata.requestCount,
      isActive: metadata.isActive,
      rateLimitPerMin: metadata.rateLimitPerMin,
      description: metadata.description,
      role: metadata.role,
      rotating: !!(metadata.rotationExpiresAt && Date.now() < metadata.rotationExpiresAt),
    }));
  }

  /**
   * Update rate limit for a key
   */
  updateRateLimit(key: string, newLimit: number): boolean {
    const metadata = this.keys.get(key);
    if (!metadata) return false;

    metadata.rateLimitPerMin = newLimit;
    logger.info(`Updated rate limit for ${key.substring(0, 8)}... to ${newLimit} req/min`);

    return true;
  }

  /**
   * Update role for a key
   */
  updateRole(key: string, role: Role): boolean {
    const metadata = this.keys.get(key);
    if (!metadata) return false;

    metadata.role = role;
    logger.info(`Updated role for ${key.substring(0, 8)}... to ${role}`);

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
    const randomBytes = crypto.randomBytes(32);
    return `sk_${randomBytes.toString('hex')}`;
  }

  private loadKeysFromEnv(): void {
    const envKeys = process.env.API_KEYS;
    if (!envKeys) {
      if (this.keys.size === 0) {
        const adminKey = this.generateKey(10000, 'Default admin key', 'admin');
        logger.info(`Generated default admin key: ${adminKey.key}`);
        logger.info('Store this key securely and use it for admin operations');
      }
      return;
    }

    try {
      // Format: key1:limit1:desc1:role1,key2:limit2:desc2:role2
      const keyConfigs = envKeys.split(',');
      for (const config of keyConfigs) {
        const parts = config.trim().split(':');
        if (parts.length >= 2) {
          const key = parts[0];
          const limit = parseInt(parts[1], 10);
          const description = parts[2];
          const role = (parts[3] as Role) || 'admin';

          const metadata: ApiKeyMetadata = {
            key,
            createdAt: Date.now(),
            lastUsed: null,
            requestCount: 0,
            isActive: true,
            rateLimitPerMin: isNaN(limit) ? 100 : limit,
            description,
            role,
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
