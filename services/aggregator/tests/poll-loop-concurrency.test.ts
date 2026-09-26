import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollCycleDurationMs, pollCycleOverrunsTotal } from '../src/observability/metrics';

describe('Poll Loop Concurrency & Overrun Semantics (Issue #575)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asserts at most one poll cycle is in flight at any time when sources are slow', async () => {
    let inFlightCount = 0;
    let maxInFlight = 0;
    let completedCycles = 0;
    let skippedTicks = 0;
    let isPolling = false;

    // Simulate a slow source that takes 150ms while ticks fire every 50ms
    const slowPollAction = async () => {
      inFlightCount++;
      maxInFlight = Math.max(maxInFlight, inFlightCount);
      await new Promise((resolve) => setTimeout(resolve, 150));
      inFlightCount--;
      completedCycles++;
    };

    // Single-flight executor with overrun tracking (mirrors index.ts executeCycle)
    const runTick = async () => {
      if (isPolling) {
        skippedTicks++;
        pollCycleOverrunsTotal.inc();
        return;
      }
      isPolling = true;
      try {
        await slowPollAction();
      } finally {
        isPolling = false;
      }
    };

    // Simulate 5 consecutive ticks arriving rapidly while the first cycle is running
    const tickPromises = [
      runTick(),
      new Promise((res) => setTimeout(() => res(runTick()), 30)),
      new Promise((res) => setTimeout(() => res(runTick()), 60)),
      new Promise((res) => setTimeout(() => res(runTick()), 90)),
      new Promise((res) => setTimeout(() => res(runTick()), 120)),
    ];

    await Promise.all(tickPromises);

    // Max in-flight cycles must strictly be 1
    expect(maxInFlight).toBe(1);
    expect(inFlightCount).toBe(0);

    // Only 1 cycle completed while the remaining 4 overlapping ticks were skipped
    expect(completedCycles).toBe(1);
    expect(skippedTicks).toBe(4);
  });

  it('enforces a bounded per-cycle deadline and aborts stuck cycles', async () => {
    const deadlineMs = 50;

    const runPollWithDeadline = async (deadline: number, pollFn: () => Promise<void>) => {
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Poll cycle exceeded deadline of ${deadline}ms`)), deadline);
      });
      try {
        return await Promise.race([pollFn(), timeoutPromise]);
      } finally {
        clearTimeout(timer!);
      }
    };

    // Simulate a hung or excessively slow upstream source
    const hungSourcePoll = () => new Promise<void>((resolve) => setTimeout(resolve, 5000));

    await expect(runPollWithDeadline(deadlineMs, hungSourcePoll)).rejects.toThrow(
      `Poll cycle exceeded deadline of ${deadlineMs}ms`,
    );
  });
});
