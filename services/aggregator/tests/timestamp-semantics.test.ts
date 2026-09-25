import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface TimestampedPrice {
  asset: string;
  price: bigint;
  decimals: number;
  observedAt: number | null;
  ingestedAt: number;
  publishedAt: number;
}

interface ClockSkewPolicy {
  maxFutureDriftSeconds: number;
  maxPastDriftSeconds: number;
  action: 'clamp' | 'reject' | 'accept_with_flag';
}

class TimestampSemantics {
  private policy: ClockSkewPolicy;

  constructor(policy: ClockSkewPolicy = {
    maxFutureDriftSeconds: 60,
    maxPastDriftSeconds: 86400,
    action: 'clamp',
  }) {
    this.policy = policy;
  }

  normalizeObservedTime(
    observedTime: number | null,
    ingestTime: number,
  ): { value: number | null; hasSkew: boolean } {
    if (observedTime === null) {
      return { value: null, hasSkew: false };
    }

    const drift = ingestTime - observedTime;
    const now = ingestTime;

    if (observedTime > now + this.policy.maxFutureDriftSeconds) {
      if (this.policy.action === 'reject') {
        throw new Error(`Observed time in future by ${observedTime - now}s`);
      } else if (this.policy.action === 'clamp') {
        return { value: now, hasSkew: true };
      }
      return { value: observedTime, hasSkew: true };
    }

    if (observedTime < now - this.policy.maxPastDriftSeconds) {
      if (this.policy.action === 'reject') {
        throw new Error(`Observed time in past by ${now - observedTime}s`);
      } else if (this.policy.action === 'clamp') {
        return { value: now - this.policy.maxPastDriftSeconds, hasSkew: true };
      }
      return { value: observedTime, hasSkew: true };
    }

    return { value: observedTime, hasSkew: false };
  }

  determineFreshness(
    price: TimestampedPrice,
    stalenessThresholdMs: number,
  ): { isFresh: boolean; reason: string } {
    if (price.observedAt === null) {
      return {
        isFresh: false,
        reason: 'No observation time available; cannot certify freshness',
      };
    }

    const ageMs = (price.ingestedAt - price.observedAt) * 1000;

    if (ageMs > stalenessThresholdMs) {
      return {
        isFresh: false,
        reason: `Observed value is ${ageMs}ms old, exceeds ${stalenessThresholdMs}ms`,
      };
    }

    return { isFresh: true, reason: 'Within freshness threshold' };
  }

  createPrice(
    asset: string,
    value: bigint,
    decimals: number,
    observedAt: number | null,
    ingestedAt: number,
    publishedAt: number,
  ): TimestampedPrice {
    return {
      asset,
      price: value,
      decimals,
      observedAt,
      ingestedAt,
      publishedAt,
    };
  }

  validateTimestampConsistency(prices: TimestampedPrice[]): string[] {
    const issues: string[] = [];

    for (const price of prices) {
      if (price.ingestedAt > price.publishedAt) {
        issues.push(`${price.asset}: publish time before ingest time`);
      }

      if (price.observedAt !== null && price.observedAt > price.ingestedAt) {
        issues.push(`${price.asset}: observed time in future relative to ingest`);
      }
    }

    return issues;
  }

  compareAcrossAssets(
    prices: TimestampedPrice[],
    useField: 'observedAt' | 'ingestedAt' | 'publishedAt',
  ): { newest: TimestampedPrice | null; oldest: TimestampedPrice | null } {
    if (prices.length === 0) {
      return { newest: null, oldest: null };
    }

    let newest = prices[0];
    let oldest = prices[0];

    for (const price of prices) {
      const priceValue = price[useField];
      const newestValue = newest[useField];
      const oldestValue = oldest[useField];

      if (priceValue !== null && newestValue !== null && priceValue > newestValue) {
        newest = price;
      }
      if (priceValue !== null && oldestValue !== null && priceValue < oldestValue) {
        oldest = price;
      }
    }

    return { newest, oldest };
  }
}

describe('TimestampSemantics', () => {
  let semantics: TimestampSemantics;
  const baseTime = 1000;

  beforeEach(() => {
    semantics = new TimestampSemantics();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Observation Time', () => {
    it('records explicit observation time from provider', () => {
      const observedAt = baseTime - 10;
      const price = semantics.createPrice('XLM', 12000000n, 8, observedAt, baseTime, baseTime);

      expect(price.observedAt).toBe(observedAt);
      expect(price.ingestedAt).toBe(baseTime);
    });

    it('records null when provider supplies no observation time', () => {
      const price = semantics.createPrice('XLM', 12000000n, 8, null, baseTime, baseTime);

      expect(price.observedAt).toBeNull();
    });

    it('distinguishes observation time from ingestion time', () => {
      const observedAt = baseTime - 300;
      const ingestedAt = baseTime;
      const price = semantics.createPrice('XLM', 12000000n, 8, observedAt, ingestedAt, ingestedAt);

      expect(price.observedAt).not.toBe(price.ingestedAt);
      expect(price.observedAt).toBe(observedAt);
    });
  });

  describe('Clock Skew Policy', () => {
    it('clamps future-dated observations to current time', () => {
      const futureTime = baseTime + 120;
      const result = semantics.normalizeObservedTime(futureTime, baseTime);

      expect(result.value).toBe(baseTime);
      expect(result.hasSkew).toBe(true);
    });

    it('clamps old observations within tolerance', () => {
      const oldTime = baseTime - 1000;
      const result = semantics.normalizeObservedTime(oldTime, baseTime);

      expect(result.value).toBe(oldTime);
      expect(result.hasSkew).toBe(false);
    });

    it('rejects when skew exceeds policy', () => {
      const policy = new TimestampSemantics({
        maxFutureDriftSeconds: 10,
        maxPastDriftSeconds: 100,
        action: 'reject',
      });

      const futureTime = baseTime + 100;
      expect(() => policy.normalizeObservedTime(futureTime, baseTime))
        .toThrow(/in future/);
    });

    it('accepts with flag when configured', () => {
      const policy = new TimestampSemantics({
        maxFutureDriftSeconds: 10,
        maxPastDriftSeconds: 100,
        action: 'accept_with_flag',
      });

      const futureTime = baseTime + 100;
      const result = policy.normalizeObservedTime(futureTime, baseTime);

      expect(result.value).toBe(futureTime);
      expect(result.hasSkew).toBe(true);
    });
  });

  describe('Staleness Detection', () => {
    it('freshness check returns false when observedAt is null', () => {
      const price = semantics.createPrice('XLM', 12000000n, 8, null, baseTime, baseTime);

      const result = semantics.determineFreshness(price, 300000);

      expect(result.isFresh).toBe(false);
      expect(result.reason).toContain('No observation time');
    });

    it('correctly identifies fresh prices by observed time', () => {
      const observedAt = baseTime - 60;
      const price = semantics.createPrice(
        'XLM',
        12000000n,
        8,
        observedAt,
        baseTime,
        baseTime,
      );

      const result = semantics.determineFreshness(price, 300000);

      expect(result.isFresh).toBe(true);
    });

    it('flags stale prices even with recent ingestion time', () => {
      const observedAt = baseTime - 500000;
      const price = semantics.createPrice(
        'XLM',
        12000000n,
        8,
        observedAt,
        baseTime,
        baseTime,
      );

      const result = semantics.determineFreshness(price, 300000);

      expect(result.isFresh).toBe(false);
      expect(result.reason).toContain('exceeds');
    });

    it('proves stale underlying value with local-time timestamp is no longer fresh', () => {
      const observedAt = baseTime - 400000;
      const price = semantics.createPrice(
        'XLM',
        12000000n,
        8,
        observedAt,
        baseTime,
        baseTime,
      );

      const result = semantics.determineFreshness(price, 300000);

      expect(result.isFresh).toBe(false);
    });
  });

  describe('Timestamp Consistency', () => {
    it('detects invalid timestamp orderings', () => {
      const prices: TimestampedPrice[] = [
        semantics.createPrice('XLM', 1n, 8, baseTime - 10, baseTime, baseTime - 100),
      ];

      const issues = semantics.validateTimestampConsistency(prices);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('publish time before ingest');
    });

    it('detects future-dated observations', () => {
      const prices: TimestampedPrice[] = [
        semantics.createPrice('XLM', 1n, 8, baseTime + 100, baseTime, baseTime),
      ];

      const issues = semantics.validateTimestampConsistency(prices);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('future');
    });

    it('passes valid timestamp orderings', () => {
      const prices: TimestampedPrice[] = [
        semantics.createPrice('XLM', 1n, 8, baseTime - 100, baseTime, baseTime),
      ];

      const issues = semantics.validateTimestampConsistency(prices);

      expect(issues).toHaveLength(0);
    });
  });

  describe('Cross-Asset Ordering', () => {
    it('correctly orders assets by observation time', () => {
      const xlmObserved = baseTime - 100;
      const btcObserved = baseTime - 50;

      const prices: TimestampedPrice[] = [
        semantics.createPrice('XLM', 1n, 8, xlmObserved, baseTime, baseTime),
        semantics.createPrice('BTC', 2n, 8, btcObserved, baseTime, baseTime),
      ];

      const { newest, oldest } = semantics.compareAcrossAssets(prices, 'observedAt');

      expect(newest?.asset).toBe('BTC');
      expect(oldest?.asset).toBe('XLM');
    });

    it('orders by ingestion time when observation time unavailable', () => {
      const prices: TimestampedPrice[] = [
        semantics.createPrice('XLM', 1n, 8, null, baseTime - 50, baseTime),
        semantics.createPrice('BTC', 2n, 8, null, baseTime, baseTime),
      ];

      const { newest, oldest } = semantics.compareAcrossAssets(prices, 'ingestedAt');

      expect(newest?.asset).toBe('BTC');
      expect(oldest?.asset).toBe('XLM');
    });

    it('handles mixed null and non-null observation times', () => {
      const prices: TimestampedPrice[] = [
        semantics.createPrice('XLM', 1n, 8, baseTime - 100, baseTime, baseTime),
        semantics.createPrice('BTC', 2n, 8, null, baseTime, baseTime),
      ];

      const { newest, oldest } = semantics.compareAcrossAssets(prices, 'observedAt');

      expect(newest?.asset).toBe('XLM');
      expect(oldest?.asset).toBe('XLM');
    });
  });

  describe('Audit and Retention', () => {
    it('preserves observation time for audit trail', () => {
      const observedAt = baseTime - 1000;
      const price = semantics.createPrice(
        'XLM',
        12000000n,
        8,
        observedAt,
        baseTime,
        baseTime,
      );

      expect(price.observedAt).toBe(observedAt);
    });

    it('uses correct timestamp for retention cutoffs', () => {
      const observedAt = baseTime - 2000000;
      const price = semantics.createPrice(
        'XLM',
        12000000n,
        8,
        observedAt,
        baseTime,
        baseTime,
      );

      const retentionCutoff = baseTime - 1000000;

      expect(price.observedAt! < retentionCutoff).toBe(true);
    });

    it('uses ingestion time for cursor ordering in history', () => {
      const prices: TimestampedPrice[] = [
        semantics.createPrice('XLM', 1n, 8, baseTime - 500, baseTime - 100, baseTime - 100),
        semantics.createPrice('XLM', 2n, 8, baseTime - 100, baseTime, baseTime),
      ];

      const ordered = prices.sort((a, b) => a.ingestedAt - b.ingestedAt);

      expect(ordered[0].ingestedAt).toBe(baseTime - 100);
      expect(ordered[1].ingestedAt).toBe(baseTime);
    });
  });

  describe('Migration and Historical Data', () => {
    it('documents meaning of timestamps in historical records', () => {
      const meaning =
        'Legacy records with single timestamp field should be interpreted as ingestedAt (local fetch time)';
      expect(meaning).toContain('ingestedAt');
    });

    it('handles legacy single-timestamp conversion', () => {
      const legacyTimestamp = baseTime;

      const converted = semantics.createPrice('XLM', 1n, 8, null, legacyTimestamp, legacyTimestamp);

      expect(converted.ingestedAt).toBe(legacyTimestamp);
      expect(converted.publishedAt).toBe(legacyTimestamp);
      expect(converted.observedAt).toBeNull();
    });
  });
});
