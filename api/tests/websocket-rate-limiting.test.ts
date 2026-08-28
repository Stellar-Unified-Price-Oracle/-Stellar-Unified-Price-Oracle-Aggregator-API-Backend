import { describe, it, expect, beforeEach, vi } from 'vitest';

interface RateLimitConfig {
  upgradeAttemptsPerIp: number;
  upgradeWindow: number;
  messagesPerConnection: number;
  messageWindow: number;
  connectionsPerIp: number;
}

class WebSocketRateLimiter {
  private upgradeAttempts: Map<string, number[]> = new Map();
  private messageRateLimits: Map<string, number[]> = new Map();
  private connectionCounts: Map<string, number> = new Map();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  checkUpgradeLimit(ip: string, now: number = Date.now()): boolean {
    const window = this.config.upgradeWindow * 1000;
    const attempts = this.upgradeAttempts.get(ip) || [];

    const recentAttempts = attempts.filter((t) => now - t < window);
    if (recentAttempts.length >= this.config.upgradeAttemptsPerIp) {
      return false;
    }

    recentAttempts.push(now);
    this.upgradeAttempts.set(ip, recentAttempts);
    return true;
  }

  checkMessageLimit(connectionId: string, now: number = Date.now()): boolean {
    const window = this.config.messageWindow * 1000;
    const messages = this.messageRateLimits.get(connectionId) || [];

    const recentMessages = messages.filter((t) => now - t < window);
    if (recentMessages.length >= this.config.messagesPerConnection) {
      return false;
    }

    recentMessages.push(now);
    this.messageRateLimits.set(connectionId, recentMessages);
    return true;
  }

  checkConnectionCount(ip: string): boolean {
    const count = this.connectionCounts.get(ip) || 0;
    if (count >= this.config.connectionsPerIp) {
      return false;
    }

    this.connectionCounts.set(ip, count + 1);
    return true;
  }

  incrementConnection(ip: string): void {
    const count = this.connectionCounts.get(ip) || 0;
    this.connectionCounts.set(ip, count + 1);
  }

  decrementConnection(ip: string): void {
    const count = this.connectionCounts.get(ip) || 0;
    if (count > 0) {
      this.connectionCounts.set(ip, count - 1);
    }
  }

  getConnectionCount(ip: string): number {
    return this.connectionCounts.get(ip) || 0;
  }

  reset(): void {
    this.upgradeAttempts.clear();
    this.messageRateLimits.clear();
    this.connectionCounts.clear();
  }
}

describe('WebSocket Rate Limiting', () => {
  let limiter: WebSocketRateLimiter;
  const config: RateLimitConfig = {
    upgradeAttemptsPerIp: 10,
    upgradeWindow: 60,
    messagesPerConnection: 100,
    messageWindow: 60,
    connectionsPerIp: 5,
  };

  beforeEach(() => {
    limiter = new WebSocketRateLimiter(config);
  });

  describe('Upgrade Attempt Rate Limiting', () => {
    it('should allow upgrade attempts within limit', () => {
      const ip = '192.168.1.1';

      for (let i = 0; i < config.upgradeAttemptsPerIp; i++) {
        const allowed = limiter.checkUpgradeLimit(ip);
        expect(allowed).toBe(true);
      }
    });

    it('should block upgrade attempts exceeding limit', () => {
      const ip = '192.168.1.1';

      for (let i = 0; i < config.upgradeAttemptsPerIp; i++) {
        limiter.checkUpgradeLimit(ip);
      }

      const blocked = limiter.checkUpgradeLimit(ip);
      expect(blocked).toBe(false);
    });

    it('should reset upgrade attempts after time window', () => {
      const ip = '192.168.1.1';
      const now = Date.now();
      const windowMs = config.upgradeWindow * 1000;

      for (let i = 0; i < config.upgradeAttemptsPerIp; i++) {
        limiter.checkUpgradeLimit(ip, now);
      }

      const blocked = limiter.checkUpgradeLimit(ip, now);
      expect(blocked).toBe(false);

      const allowed = limiter.checkUpgradeLimit(ip, now + windowMs + 1000);
      expect(allowed).toBe(true);
    });

    it('should track different IPs independently', () => {
      const ip1 = '192.168.1.1';
      const ip2 = '192.168.1.2';

      for (let i = 0; i < config.upgradeAttemptsPerIp; i++) {
        limiter.checkUpgradeLimit(ip1);
      }

      const blocked = limiter.checkUpgradeLimit(ip1);
      expect(blocked).toBe(false);

      const allowed = limiter.checkUpgradeLimit(ip2);
      expect(allowed).toBe(true);
    });
  });

  describe('Per-Connection Message Rate Limiting', () => {
    it('should allow messages within limit', () => {
      const connId = 'conn-1';

      for (let i = 0; i < config.messagesPerConnection; i++) {
        const allowed = limiter.checkMessageLimit(connId);
        expect(allowed).toBe(true);
      }
    });

    it('should block messages exceeding limit', () => {
      const connId = 'conn-1';

      for (let i = 0; i < config.messagesPerConnection; i++) {
        limiter.checkMessageLimit(connId);
      }

      const blocked = limiter.checkMessageLimit(connId);
      expect(blocked).toBe(false);
    });

    it('should reset message count after time window', () => {
      const connId = 'conn-1';
      const now = Date.now();
      const windowMs = config.messageWindow * 1000;

      for (let i = 0; i < config.messagesPerConnection; i++) {
        limiter.checkMessageLimit(connId, now);
      }

      const blocked = limiter.checkMessageLimit(connId, now);
      expect(blocked).toBe(false);

      const allowed = limiter.checkMessageLimit(connId, now + windowMs + 1000);
      expect(allowed).toBe(true);
    });

    it('should track different connections independently', () => {
      const connId1 = 'conn-1';
      const connId2 = 'conn-2';

      for (let i = 0; i < config.messagesPerConnection; i++) {
        limiter.checkMessageLimit(connId1);
      }

      const blocked = limiter.checkMessageLimit(connId1);
      expect(blocked).toBe(false);

      const allowed = limiter.checkMessageLimit(connId2);
      expect(allowed).toBe(true);
    });
  });

  describe('Connection Count Rate Limiting', () => {
    it('should allow connections within limit', () => {
      const ip = '192.168.1.1';

      // checkConnectionCount already increments the counter on success.
      for (let i = 0; i < config.connectionsPerIp; i++) {
        const allowed = limiter.checkConnectionCount(ip);
        expect(allowed).toBe(true);
      }
      expect(limiter.getConnectionCount(ip)).toBe(config.connectionsPerIp);
    });

    it('should block connections exceeding limit', () => {
      const ip = '192.168.1.1';

      for (let i = 0; i < config.connectionsPerIp; i++) {
        limiter.checkConnectionCount(ip);
      }

      const blocked = limiter.checkConnectionCount(ip);
      expect(blocked).toBe(false);
    });

    it('should allow new connection after one closes', () => {
      const ip = '192.168.1.1';

      for (let i = 0; i < config.connectionsPerIp; i++) {
        limiter.checkConnectionCount(ip);
      }

      expect(limiter.getConnectionCount(ip)).toBe(config.connectionsPerIp);

      limiter.decrementConnection(ip);
      expect(limiter.getConnectionCount(ip)).toBe(config.connectionsPerIp - 1);

      const allowed = limiter.checkConnectionCount(ip);
      expect(allowed).toBe(true);
    });

    it('should track different IPs independently', () => {
      const ip1 = '192.168.1.1';
      const ip2 = '192.168.1.2';

      for (let i = 0; i < config.connectionsPerIp; i++) {
        limiter.incrementConnection(ip1);
      }

      expect(limiter.checkConnectionCount(ip1)).toBe(false);
      expect(limiter.checkConnectionCount(ip2)).toBe(true);
    });

    it('should not decrement below zero', () => {
      const ip = '192.168.1.1';

      limiter.decrementConnection(ip);
      limiter.decrementConnection(ip);

      expect(limiter.getConnectionCount(ip)).toBe(0);
    });
  });

  describe('Combined Rate Limiting', () => {
    it('should enforce all rate limits together', () => {
      const ip = '192.168.1.1';
      const connId = 'conn-1';

      for (let i = 0; i < config.connectionsPerIp; i++) {
        limiter.incrementConnection(ip);
      }

      expect(limiter.getConnectionCount(ip)).toBe(config.connectionsPerIp);

      for (let i = 0; i < config.messagesPerConnection; i++) {
        const allowed = limiter.checkMessageLimit(connId);
        expect(allowed).toBe(true);
      }

      const messageBlocked = limiter.checkMessageLimit(connId);
      expect(messageBlocked).toBe(false);
    });

    it('should handle burst attacks', () => {
      const ip = '192.168.1.100';
      const now = Date.now();

      const results = [];
      for (let i = 0; i < config.upgradeAttemptsPerIp + 5; i++) {
        results.push(limiter.checkUpgradeLimit(ip, now));
      }

      expect(results.filter((r) => r).length).toBe(config.upgradeAttemptsPerIp);
      expect(results.filter((r) => !r).length).toBe(5);
    });
  });

  describe('Cleanup and Reset', () => {
    it('should reset all limits', () => {
      const ip = '192.168.1.1';
      const connId = 'conn-1';

      limiter.checkUpgradeLimit(ip);
      limiter.checkMessageLimit(connId);
      limiter.incrementConnection(ip);

      limiter.reset();

      expect(limiter.getConnectionCount(ip)).toBe(0);
      expect(limiter.checkUpgradeLimit(ip)).toBe(true);
      expect(limiter.checkMessageLimit(connId)).toBe(true);
    });
  });

  describe('Rate Limit Configuration', () => {
    it('should respect upgrade limit configuration', () => {
      const customConfig: RateLimitConfig = {
        upgradeAttemptsPerIp: 5,
        upgradeWindow: 30,
        messagesPerConnection: 100,
        messageWindow: 60,
        connectionsPerIp: 5,
      };

      const customLimiter = new WebSocketRateLimiter(customConfig);
      const ip = '192.168.1.1';

      for (let i = 0; i < 5; i++) {
        expect(customLimiter.checkUpgradeLimit(ip)).toBe(true);
      }

      expect(customLimiter.checkUpgradeLimit(ip)).toBe(false);
    });

    it('should respect message limit configuration', () => {
      const customConfig: RateLimitConfig = {
        upgradeAttemptsPerIp: 10,
        upgradeWindow: 60,
        messagesPerConnection: 50,
        messageWindow: 60,
        connectionsPerIp: 5,
      };

      const customLimiter = new WebSocketRateLimiter(customConfig);
      const connId = 'conn-1';

      for (let i = 0; i < 50; i++) {
        expect(customLimiter.checkMessageLimit(connId)).toBe(true);
      }

      expect(customLimiter.checkMessageLimit(connId)).toBe(false);
    });

    it('should respect connection limit configuration', () => {
      const customConfig: RateLimitConfig = {
        upgradeAttemptsPerIp: 10,
        upgradeWindow: 60,
        messagesPerConnection: 100,
        messageWindow: 60,
        connectionsPerIp: 3,
      };

      const customLimiter = new WebSocketRateLimiter(customConfig);
      const ip = '192.168.1.1';

      for (let i = 0; i < 3; i++) {
        customLimiter.incrementConnection(ip);
      }

      expect(customLimiter.checkConnectionCount(ip)).toBe(false);
    });
  });
});
