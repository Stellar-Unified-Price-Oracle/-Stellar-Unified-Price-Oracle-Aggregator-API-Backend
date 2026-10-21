import { describe, it, expect } from 'vitest';
import {
  ReplayBuffer,
  ReplayRateLimiter,
  collectReplayWindow,
  BufferedMessage,
} from '../../src/infrastructure/ws-replay';

function message(sequenceId: number, asset = 'BTC'): BufferedMessage {
  return { sequenceId, asset, timestamp: 1700000000, data: { asset, price: 100 + sequenceId } };
}

describe('replay window bounds (issue #606)', () => {
  it('exposes the oldest retained sequence so consumers can detect a cursor gap', () => {
    const buffer = new ReplayBuffer(2, 2, 10_000);
    buffer.push('BTC', message(8));
    buffer.push('BTC', message(9));
    buffer.push('BTC', message(10));
    expect(buffer.oldestSequence()).toBe(9);
  });

  it('is bounded by message count when every buffered asset is replayed', () => {
    const sources = [Array.from({ length: 50 }, (_, i) => message(i + 1)), Array.from({ length: 50 }, (_, i) => message(i + 51, 'XLM'))];

    const window = collectReplayWindow(sources, 0, { maxMessages: 10, maxBytes: 1_000_000 });

    expect(window.messages).toHaveLength(10);
    expect(window.truncated).toBe(true);
    expect(window.remaining).toBe(90);
    expect(window.messages[0].sequenceId).toBe(1);
    expect(window.messages.map((m) => m.sequenceId)).toEqual([...window.messages].map((m) => m.sequenceId).sort((a, b) => a - b));
  });

  it('is bounded by total bytes', () => {
    const sources = [Array.from({ length: 20 }, (_, i) => message(i + 1))];

    const window = collectReplayWindow(sources, 0, { maxMessages: 1000, maxBytes: 400 });

    expect(window.bytes).toBeLessThanOrEqual(400);
    expect(window.messages.length).toBeGreaterThan(0);
    expect(window.messages.length).toBeLessThan(20);
    expect(window.truncated).toBe(true);
  });

  it('reports caught up when there is nothing above the cursor', () => {
    const sources = [Array.from({ length: 5 }, (_, i) => message(i + 1))];

    const window = collectReplayWindow(sources, 5, { maxMessages: 10, maxBytes: 10_000 });

    expect(window.messages).toHaveLength(0);
    expect(window.truncated).toBe(false);
    expect(window.remaining).toBe(0);
  });

  it('filters by the cursor and by asset', () => {
    const sources = [Array.from({ length: 10 }, (_, i) => message(i + 1)), Array.from({ length: 10 }, (_, i) => message(i + 1, 'XLM'))];

    const window = collectReplayWindow([sources[1]], 4, { maxMessages: 100, maxBytes: 10_000 });

    expect(window.messages.every((m) => m.asset === 'XLM')).toBe(true);
    expect(window.messages.every((m) => m.sequenceId > 4)).toBe(true);
    expect(window.truncated).toBe(false);
  });
});

describe('replay rate limiting', () => {
  it('allows up to the limit and then rejects within the window', () => {
    const limiter = new ReplayRateLimiter(3, 60_000);
    const now = 1_000_000;

    expect(limiter.allow('conn-1', now)).toBe(true);
    expect(limiter.allow('conn-1', now)).toBe(true);
    expect(limiter.allow('conn-1', now)).toBe(true);
    expect(limiter.allow('conn-1', now)).toBe(false);
  });

  it('forgets requests once the window passes', () => {
    const limiter = new ReplayRateLimiter(2, 60_000);
    const now = 1_000_000;

    expect(limiter.allow('conn-1', now)).toBe(true);
    expect(limiter.allow('conn-1', now)).toBe(true);
    expect(limiter.allow('conn-1', now)).toBe(false);
    expect(limiter.allow('conn-1', now + 60_001)).toBe(true);
  });

  it('tracks connections independently', () => {
    const limiter = new ReplayRateLimiter(1, 60_000);

    expect(limiter.allow('conn-1')).toBe(true);
    expect(limiter.allow('conn-1')).toBe(false);
    expect(limiter.allow('conn-2')).toBe(true);
  });

  it('prunes idle connections', () => {
    const limiter = new ReplayRateLimiter(1, 1_000);
    limiter.allow('conn-1', 1_000_000);
    limiter.prune(1_002_000);
    expect(limiter.allow('conn-1', 1_002_000)).toBe(true);
  });
});

describe('replay buffer caps', () => {
  it('caps the number of messages per asset', () => {
    const buffer = new ReplayBuffer(10, 5, 1_000_000);
    for (let i = 1; i <= 20; i++) buffer.push('BTC', message(i));

    const [messages] = buffer.sources(['BTC']);
    expect(messages).toHaveLength(5);
    expect(messages[0].sequenceId).toBe(16);
    expect(buffer.stats()).toEqual({ assets: 1, messages: 5, bytes: buffer.stats().bytes });
  });

  it('caps the number of buffered assets and evicts the oldest', () => {
    const buffer = new ReplayBuffer(3, 10, 1_000_000);
    buffer.push('BTC', message(1, 'BTC'));
    buffer.push('ETH', message(2, 'ETH'));
    buffer.push('SOL', message(3, 'SOL'));
    buffer.push('XLM', message(4, 'XLM'));

    expect(buffer.stats().assets).toBe(3);
    expect(buffer.has('BTC')).toBe(false);
    expect(buffer.has('XLM')).toBe(true);
  });

  it('caps total buffer bytes across assets', () => {
    const buffer = new ReplayBuffer(100, 100, 1_000);
    for (let i = 1; i <= 100; i++) buffer.push(`ASSET${i}`, message(i, `ASSET${i}`));

    const stats = buffer.stats();
    expect(stats.bytes).toBeLessThanOrEqual(1_000);
    expect(stats.messages).toBeLessThan(100);
  });

  it('reports an empty snapshot for an unknown asset', () => {
    const buffer = new ReplayBuffer(10, 10, 10_000);
    expect(buffer.sources(['NOPE'])).toEqual([[]]);
    expect(buffer.stats()).toEqual({ assets: 0, messages: 0, bytes: 0 });
  });

  it('clears everything on stop', () => {
    const buffer = new ReplayBuffer(10, 10, 10_000);
    buffer.push('BTC', message(1));
    buffer.clear();
    expect(buffer.stats()).toEqual({ assets: 0, messages: 0, bytes: 0 });
  });
});
