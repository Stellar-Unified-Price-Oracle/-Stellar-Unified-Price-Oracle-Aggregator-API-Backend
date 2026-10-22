import { describe, expect, it } from 'vitest';
import { SourceBiasTracker } from '../src/price-aggregation/source-bias';

describe('source bias tracker', () => {
  it('waits for enough observations and flags persistent signed drift with its interval', () => {
    const tracker = new SourceBiasTracker(12, 10, 1);
    for (let i = 0; i < 9; i++) expect(tracker.observe('XLM', 'provider-a', 102, [100, 100])).toBeNull();
    const estimate = tracker.observe('XLM', 'provider-a', 102, [100, 100]);
    expect(estimate).toMatchObject({ observations: 10, significant: true });
    expect(estimate!.lower95).toBeGreaterThan(1);
    expect(estimate!.meanPercent).toBeCloseTo(2);
  });

  it('does not alert on balanced noise and ignores missing peer references', () => {
    const tracker = new SourceBiasTracker(10, 5, 1);
    const prices = [99.8, 100.2, 99.9, 100.1, 100];
    let result = null;
    for (const price of prices) result = tracker.observe('XLM', 'provider-a', price, [100, 100]);
    expect(result?.significant).toBe(false);
    expect(tracker.observe('XLM', 'provider-b', 100, [100])).toBeNull();
    expect(tracker.observe('XLM', 'provider-b', Number.NaN, [100, 101])).toBeNull();
  });
});
