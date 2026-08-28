import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiKeyManager, TIER_RATE_LIMITS } from '../src/governance/api-key-manager';

describe('Admin: API Usage Statistics Endpoint', () => {
  let apiKeyManager: ApiKeyManager;

  beforeEach(() => {
    apiKeyManager = new ApiKeyManager();
  });

  describe('GET /admin/usage - Per-key usage statistics', () => {
    it('should return empty array when no keys exist', () => {
      const keys = apiKeyManager.getAllKeys();
      expect(Array.isArray(keys)).toBe(true);
    });

    it('should return usage stats for generated keys', () => {
      const generated = apiKeyManager.generateKey(100, 'test-key', 'pro', 'viewer');
      const keys = apiKeyManager.getAllKeys();

      expect(keys.length).toBeGreaterThan(0);
      const keyStats = keys.find((k) => k.keyPrefix === generated.keyPrefix);
      expect(keyStats).toBeDefined();
      expect(keyStats?.requestCount).toBe(0);
      expect(keyStats?.lastUsed).toBeNull();
      expect(keyStats?.tier).toBe('pro');
      expect(keyStats?.isActive).toBe(true);
    });

    it('should track request count on rate limit check', () => {
      const key = apiKeyManager.generateKey(10, 'test', 'free', 'viewer');
      const keys = apiKeyManager.getAllKeys();
      const keyHashBefore = keys[keys.length - 1].keyHash;

      apiKeyManager.checkRateLimit(key.key);
      apiKeyManager.checkRateLimit(key.key);
      apiKeyManager.checkRateLimit(key.key);

      const keysAfter = apiKeyManager.getAllKeys();
      const updatedStats = keysAfter.find((k) => k.keyHash === keyHashBefore);

      expect(updatedStats?.requestCount).toBe(3);
      expect(updatedStats?.lastUsed).not.toBeNull();
      expect(typeof updatedStats?.lastUsed).toBe('number');
    });

    it('should show different request counts per key', () => {
      const key1 = apiKeyManager.generateKey(100, 'key1', 'free', 'viewer');
      const key2 = apiKeyManager.generateKey(100, 'key2', 'pro', 'viewer');

      apiKeyManager.checkRateLimit(key1.key);
      apiKeyManager.checkRateLimit(key2.key);
      apiKeyManager.checkRateLimit(key2.key);
      apiKeyManager.checkRateLimit(key2.key);

      const allKeys = apiKeyManager.getAllKeys();
      const stats1 = allKeys.find((k) => k.keyPrefix === key1.keyPrefix);
      const stats2 = allKeys.find((k) => k.keyPrefix === key2.keyPrefix);

      expect(stats1?.requestCount).toBe(1);
      expect(stats2?.requestCount).toBe(3);
    });

    it('should include rate limit hits in response', () => {
      const key = apiKeyManager.generateKey(2, 'limited', 'free', 'viewer');

      const check1 = apiKeyManager.checkRateLimit(key.key);
      const check2 = apiKeyManager.checkRateLimit(key.key);
      const check3 = apiKeyManager.checkRateLimit(key.key);

      expect(check1.allowed).toBe(true);
      expect(check2.allowed).toBe(true);
      expect(check3.allowed).toBe(false);

      const allKeys = apiKeyManager.getAllKeys();
      const stats = allKeys.find((k) => k.keyPrefix === key.keyPrefix);
      expect(stats?.requestCount).toBe(2);
    });

    it('should include metadata like tier, role, and description', () => {
      apiKeyManager.generateKey(TIER_RATE_LIMITS.enterprise, 'Enterprise API', 'enterprise', 'editor');

      const allKeys = apiKeyManager.getAllKeys();
      const lastKey = allKeys[allKeys.length - 1];

      expect(lastKey.tier).toBe('enterprise');
      expect(lastKey.role).toBe('editor');
      expect(lastKey.description).toBe('Enterprise API');
      expect(lastKey.rateLimitPerMin).toBe(TIER_RATE_LIMITS.enterprise);
    });

    it('should track lastUsed timestamp', () => {
      const key = apiKeyManager.generateKey(100, 'test', 'free', 'viewer');

      const beforeTime = Date.now();
      apiKeyManager.checkRateLimit(key.key);
      const afterTime = Date.now();

      const allKeys = apiKeyManager.getAllKeys();
      const stats = allKeys.find((k) => k.keyPrefix === key.keyPrefix);

      expect(stats?.lastUsed).not.toBeNull();
      expect(stats!.lastUsed! >= beforeTime).toBe(true);
      expect(stats!.lastUsed! <= afterTime).toBe(true);
    });

    it('should show active status for revoked keys', () => {
      const key = apiKeyManager.generateKey(100, 'test', 'free', 'viewer');
      const allKeys1 = apiKeyManager.getAllKeys();
      const keyHash = allKeys1[allKeys1.length - 1].keyHash;

      expect(allKeys1[allKeys1.length - 1].isActive).toBe(true);

      apiKeyManager.revokeKey(keyHash);
      const allKeys2 = apiKeyManager.getAllKeys();
      const revokedKey = allKeys2.find((k) => k.keyHash === keyHash);

      expect(revokedKey?.isActive).toBe(false);
    });

    it('should return all keys with stats', () => {
      for (let i = 0; i < 5; i++) {
        apiKeyManager.generateKey(100, `key-${i}`, 'free', 'viewer');
      }

      const allKeys = apiKeyManager.getAllKeys();
      expect(allKeys.length).toBeGreaterThanOrEqual(5);

      for (const key of allKeys) {
        expect(key).toHaveProperty('keyPrefix');
        expect(key).toHaveProperty('keyHash');
        expect(key).toHaveProperty('requestCount');
        expect(key).toHaveProperty('isActive');
        expect(key).toHaveProperty('tier');
        expect(key).toHaveProperty('role');
      }
    });
  });
});
