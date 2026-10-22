import { describe, it, expect } from 'vitest';
import {
  evaluateQuorum,
  validateFeedPolicy,
  type FeedPolicy,
} from '../../src/feeds/feed-policy';

const ISSUER_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ISSUER_B = 'GBBDK7WJVXH5XKXYMZ4XWJHZLJ3YWHM4U4M7YF3DGFHIRYEJYY3A7SCD';

function policy(overrides: Partial<FeedPolicy> = {}): FeedPolicy {
  return {
    feedId: 'btc-usd',
    asset: `public:BTC:${ISSUER_A}`,
    version: 1,
    sources: [
      { name: 'chainlink', eligible: true, weight: 1 },
      { name: 'redstone', eligible: true, weight: 1 },
      { name: 'band', eligible: true, weight: 1 },
      { name: 'reflector', eligible: true, weight: 1 },
    ],
    quorum: { minSources: 2 },
    ...overrides,
  };
}

describe('feed policy validation (#674)', () => {
  it('accepts a well-formed policy', () => {
    const result = validateFeedPolicy(policy());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('requires a canonical asset id', () => {
    const result = validateFeedPolicy(policy({ asset: 'BTC' }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('canonical asset id');
  });

  it('requires at least one eligible source', () => {
    const result = validateFeedPolicy(
      policy({
        sources: [
          { name: 'chainlink', eligible: false, disabledReason: 'offline' },
          { name: 'redstone', eligible: false, disabledReason: 'offline' },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('at least one source must be eligible');
  });

  it('rejects a quorum larger than the eligible source count', () => {
    const result = validateFeedPolicy(
      policy({
        sources: [
          { name: 'chainlink', eligible: true },
          { name: 'redstone', eligible: false, disabledReason: 'offline' },
        ],
        quorum: { minSources: 2 },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('exceeds the number of eligible sources');
  });

  it('rejects duplicate source declarations and non-positive weights', () => {
    const result = validateFeedPolicy(
      policy({
        sources: [
          { name: 'chainlink', eligible: true },
          { name: 'ChainLink', eligible: true, weight: 0 },
        ],
        quorum: { minSources: 1 },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('duplicate source declaration');
    expect(result.errors.join(' ')).toContain('positive weight');
  });

  it('rejects out-of-range quorum values', () => {
    const zero = validateFeedPolicy(policy({ quorum: { minSources: 0 } }));
    expect(zero.valid).toBe(false);

    const tooBig = validateFeedPolicy(policy({ quorum: { minSources: 1000 } }));
    expect(tooBig.valid).toBe(false);

    const badBps = validateFeedPolicy(policy({ quorum: { minSources: 1, minWeightBps: 0 } }));
    expect(badBps.valid).toBe(false);
    expect(badBps.errors.join(' ')).toContain('minWeightBps');
  });

  it('warns when an ineligible source has no recorded reason', () => {
    const result = validateFeedPolicy(
      policy({
        sources: [
          { name: 'chainlink', eligible: true },
          { name: 'redstone', eligible: false },
        ],
        quorum: { minSources: 1 },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('redstone');
  });

  it('accepts bounded per-feed freshness and canonical quote metadata', () => {
    const result = validateFeedPolicy(policy({
      freshness: { profile: 'realtime', warnSeconds: 8, maxAgeSeconds: 30 },
      quoteUnit: { currency: 'EUR', denomination: 'EUR_PER_ASSET_UNIT', scaleDecimals: 8, displayDecimals: 2, rounding: 'half-even' },
    }));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects invalid freshness boundaries and quote denomination', () => {
    const result = validateFeedPolicy(policy({
      freshness: { profile: 'delayed', warnSeconds: 600, maxAgeSeconds: 600 },
      quoteUnit: { currency: 'EUR', denomination: 'USD_PER_ASSET_UNIT', scaleDecimals: 19, displayDecimals: 20, rounding: 'half-even' },
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('warnSeconds');
    expect(result.errors.join(' ')).toContain('denomination');
    expect(result.errors.join(' ')).toContain('scaleDecimals');
  });
});

describe('quorum evaluation (#674)', () => {
  it('is satisfied when enough eligible sources report', () => {
    const result = evaluateQuorum(policy(), [
      { source: 'chainlink' },
      { source: 'redstone' },
    ]);
    expect(result.satisfied).toBe(true);
    expect(result.counted).toEqual(['chainlink', 'redstone']);
    expect(result.reportingSources).toBe(2);
    expect(result.eligibleSources).toBe(4);
  });

  it('fails when fewer sources than the quorum report', () => {
    const result = evaluateQuorum(policy(), [{ source: 'chainlink' }]);
    expect(result.satisfied).toBe(false);
    expect(result.failures.join(' ')).toContain('required 2');
  });

  it('ignores sources that are not eligible for the feed', () => {
    const scoped = policy({
      sources: [
        { name: 'chainlink', eligible: true },
        { name: 'redstone', eligible: false, disabledReason: 'offline' },
      ],
      quorum: { minSources: 1 },
    });
    const result = evaluateQuorum(scoped, [{ source: 'redstone' }, { source: 'chainlink' }]);
    expect(result.satisfied).toBe(true);
    expect(result.counted).toEqual(['chainlink']);
    expect(result.rejected).toEqual([
      { source: 'redstone', reason: 'source is not eligible for this feed' },
    ]);
  });

  it('counts each source only once', () => {
    const result = evaluateQuorum(policy(), [
      { source: 'chainlink' },
      { source: 'chainlink' },
    ]);
    expect(result.counted).toEqual(['chainlink']);
    expect(result.rejected[0].reason).toContain('duplicate');
    expect(result.satisfied).toBe(false);
  });

  it('does not let one issuer manufacture quorum when issuers must be distinct', () => {
    const distinct = policy({
      sources: [
        { name: 'chainlink', eligible: true },
        { name: 'redstone', eligible: true },
      ],
      quorum: { minSources: 2, distinctIssuersOnly: true },
    });
    const result = evaluateQuorum(distinct, [
      { source: 'chainlink', issuer: ISSUER_A },
      { source: 'redstone', issuer: ISSUER_A },
    ]);
    expect(result.satisfied).toBe(false);
    expect(result.rejected[0].reason).toContain('issuer already counted');
  });

  it('applies the weight quorum in basis points', () => {
    const weighted = policy({
      sources: [
        { name: 'chainlink', eligible: true, weight: 3 },
        { name: 'redstone', eligible: true, weight: 1 },
      ],
      quorum: { minSources: 1, minWeightBps: 5000 },
    });
    const light = evaluateQuorum(weighted, [{ source: 'redstone' }]);
    expect(light.satisfied).toBe(false);
    expect(light.weightBps).toBe(2500);

    const heavy = evaluateQuorum(weighted, [{ source: 'chainlink' }]);
    expect(heavy.satisfied).toBe(true);
    expect(heavy.weightBps).toBe(7500);
  });

  it('treats a policy with no contributions as unsatisfied', () => {
    const result = evaluateQuorum(policy(), []);
    expect(result.satisfied).toBe(false);
    expect(result.reportingSources).toBe(0);
  });
});
