import { describe, expect, it } from 'vitest';
import { readAssetPrices, readPriceHistory, resetSandboxData, SANDBOX_ASSETS } from '../src/services/price-store';

describe('sandbox fixtures', () => {
  it('resets deterministic data for every supported asset', async () => {
    resetSandboxData(1_700_000_000);

    const prices = await readAssetPrices();
    expect(prices.map((price) => price.asset).sort()).toEqual([...SANDBOX_ASSETS].sort());
    expect(prices.every((price) => price.source === 'sandbox-fixture')).toBe(true);

    for (const asset of SANDBOX_ASSETS) {
      const history = await readPriceHistory(asset);
      expect(history).toHaveLength(10);
      expect(history[0].timestamp).toBe(1_699_999_460);
      expect(history.at(-1).timestamp).toBe(1_700_000_000);
    }
  });
});
