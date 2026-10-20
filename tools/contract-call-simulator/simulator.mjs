// Local simulator for common Soroban consumer calls (lastprice, price, twap-style reads)
// with configurable stale, paused, missing and malformed price states.
// Zero dependencies. Mirrors consumer-visible behaviour, not contract internals.

export const STATES = ['fresh', 'stale', 'paused', 'missing', 'malformed'];

export class ContractError extends Error {
  constructor(code, message) { super(message); this.name = 'ContractError'; this.code = code; }
}

export class OracleSimulator {
  /** @param {{now?: () => number, maxAgeSeconds?: number}} opts */
  constructor({ now = () => Math.floor(Date.now() / 1000), maxAgeSeconds = 300 } = {}) {
    this.now = now;
    this.maxAgeSeconds = maxAgeSeconds;
    this.feeds = new Map();
    this.paused = false;
  }

  /** Configure a feed in one of STATES. */
  setFeed(asset, { state = 'fresh', price = 1_0000000n, decimals = 7, ageSeconds } = {}) {
    if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`);
    if (state === 'malformed') {
      this.feeds.set(asset, { price: -1n, decimals: 99, timestamp: 0 });
    } else if (state === 'missing') {
      this.feeds.delete(asset);
    } else {
      const age = ageSeconds ?? (state === 'stale' ? this.maxAgeSeconds * 2 : 0);
      this.feeds.set(asset, { price: BigInt(price), decimals, timestamp: this.now() - age });
    }
    if (state === 'paused') this.paused = true;
    return this;
  }

  setPaused(paused) { this.paused = paused; return this; }

  /** Raw read, like the contract's `lastprice`: returns null when no data. */
  lastprice(asset) {
    if (this.paused) throw new ContractError('PAUSED', 'contract is paused');
    return this.feeds.get(asset) ?? null;
  }

  /**
   * Safe consumer read: validates and throws a typed error so consumer code can be
   * tested against each failure mode.
   */
  safePrice(asset) {
    const p = this.lastprice(asset);
    if (!p) throw new ContractError('MISSING', `no price for ${asset}`);
    if (typeof p.price !== 'bigint' || p.price <= 0n || !Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 18 || p.timestamp <= 0) {
      throw new ContractError('MALFORMED', `malformed price for ${asset}`);
    }
    const age = this.now() - p.timestamp;
    if (age > this.maxAgeSeconds) throw new ContractError('STALE', `price for ${asset} is ${age}s old (max ${this.maxAgeSeconds}s)`);
    return { ...p, ageSeconds: age };
  }
}
