import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GracefulShutdownCoordinator, type ShutdownHooks } from '../src/infrastructure/shutdown';
import { writeAtomic } from '../src/persistence/history';
import fs from 'fs';
import os from 'os';
import path from 'path';

function buildHooks(overrides: Partial<ShutdownHooks> = {}): ShutdownHooks & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    flipReadiness: vi.fn(() => {
      order.push('flipReadiness');
    }),
    stopScheduledWork: vi.fn(() => {
      order.push('stopScheduledWork');
    }),
    waitForInFlightCycle: vi.fn(async () => {
      order.push('waitForInFlightCycle');
      return true;
    }),
    drainRetryQueue: vi.fn(async () => {
      order.push('drainRetryQueue');
    }),
    closeServers: vi.fn(async () => {
      order.push('closeServers');
    }),
    ...overrides,
  };
}

function buildCoordinator(hooks: ShutdownHooks, drainDeadlineMs = 1000, forceExitMs = 5000) {
  return new GracefulShutdownCoordinator(hooks, { drainDeadlineMs, forceExitMs });
}

describe('Issue #579: Graceful shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flips readiness before any other shutdown step', async () => {
    const hooks = buildHooks();
    const coordinator = buildCoordinator(hooks);

    await coordinator.run();

    expect(hooks.order[0]).toBe('flipReadiness');
    expect(hooks.order[1]).toBe('stopScheduledWork');
    // Servers close last, after the cycle wait and the queue drain.
    expect(hooks.order.indexOf('closeServers')).toBe(hooks.order.length - 1);
  });

  it('is idempotent: a second signal during shutdown is ignored', async () => {
    const hooks = buildHooks({
      waitForInFlightCycle: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return true;
      }),
    });
    const coordinator = buildCoordinator(hooks);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const first = coordinator.handleSignal('SIGTERM');
    coordinator.handleSignal('SIGTERM');
    coordinator.handleSignal('SIGINT');

    await vi.waitFor(() => expect(hooks.drainRetryQueue).toHaveBeenCalledTimes(1));
    await first;
    exitSpy.mockRestore();
    expect(coordinator.isTriggered()).toBe(true);
    expect(hooks.flipReadiness).toHaveBeenCalledTimes(1);
    expect(hooks.drainRetryQueue).toHaveBeenCalledTimes(1);
  });

  it('waits for the in-flight poll cycle to complete before draining', async () => {
    let cycleFinished = false;
    const hooks = buildHooks({
      waitForInFlightCycle: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        cycleFinished = true;
        return true;
      }),
      drainRetryQueue: vi.fn(async () => {
        expect(cycleFinished).toBe(true);
      }),
    });
    const coordinator = buildCoordinator(hooks);

    await coordinator.run();

    expect(hooks.waitForInFlightCycle).toHaveBeenCalledTimes(1);
    expect(hooks.drainRetryQueue).toHaveBeenCalledTimes(1);
  });

  it('reports deadline-exceeded with a non-zero exit code when the cycle does not finish', async () => {
    const hooks = buildHooks({
      waitForInFlightCycle: vi.fn(async () => false),
    });
    const coordinator = buildCoordinator(hooks, 50, 5000);

    const outcome = await coordinator.run();

    expect(outcome).toEqual({ result: 'deadline-exceeded', exitCode: 1 });
    // The queue drain is skipped when the cycle did not finish.
    expect(hooks.drainRetryQueue).not.toHaveBeenCalled();
    expect(hooks.closeServers).toHaveBeenCalledTimes(1);
  });

  it('drains the retry queue when the cycle completes in time', async () => {
    const hooks = buildHooks();
    const coordinator = buildCoordinator(hooks, 1000, 5000);

    const outcome = await coordinator.run();

    expect(outcome).toEqual({ result: 'drained', exitCode: 0 });
    expect(hooks.drainRetryQueue).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 when the force-exit timer fires during a hung drain', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    try {
      const hooks = buildHooks({
        waitForInFlightCycle: vi.fn(() => new Promise<boolean>(() => {})),
      });
      const coordinator = buildCoordinator(hooks, 1000, 5000);

      coordinator.handleSignal('SIGTERM');
      await vi.advanceTimersByTimeAsync(6000);

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('writes history files atomically so a kill cannot leave a partial file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
    const filePath = path.join(dir, 'history-xlm.json');

    writeAtomic(filePath, '[{"price":"100","decimals":8,"source":"chainlink","timestamp":1}]');

    const contents = fs.readFileSync(filePath, 'utf-8');
    expect(JSON.parse(contents)).toEqual([
      { price: '100', decimals: 8, source: 'chainlink', timestamp: 1 },
    ]);

    // No temp files remain after the rename.
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites an existing file atomically with the newest contents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-overwrite-'));
    const filePath = path.join(dir, 'history-usdc.json');

    writeAtomic(filePath, '[]');
    writeAtomic(filePath, '[{"price":"1","decimals":8,"source":"redstone","timestamp":2}]');

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
