import { logger } from '../observability/logger';

/**
 * Graceful shutdown for the aggregator (issue #579).
 *
 * The sequence is fixed and deliberate:
 *
 *  1. Flip readiness to not-ready FIRST, so the orchestrator drains traffic
 *     while the process can still serve. Closing servers before flipping
 *     readiness is what caused pods to be removed from rotation only after
 *     they had already stopped answering.
 *  2. Stop scheduled work (poll timer, archival loop) so no new cycle starts.
 *  3. Wait for the in-flight poll cycle, bounded by `drainDeadlineMs`.
 *     History writes and contract submissions must not be killed mid-flight.
 *  4. Drain (or persist the outcome of) the contract-submission retry queue.
 *  5. Close the WebSocket and health servers, disconnect the database.
 *
 * `drainDeadlineMs` plus `forceExitMs` must be smaller than the deployment's
 * `terminationGracePeriodSeconds` — the numbers are documented in
 * docs/PRODUCTION_DEPLOYMENT.md §10.
 */

export interface ShutdownHooks {
  /** Step 1 — must make /health/ready return 503 before any other step. */
  flipReadiness(): void;
  /** Step 2 — stop timers that schedule new poll cycles and archival passes. */
  stopScheduledWork(): void;
  /**
   * Step 3 — resolves `true` when the in-flight cycle finished, `false` when
   * the drain deadline was hit first.
   */
  waitForInFlightCycle(): Promise<boolean>;
  /** Step 4 — drain the contract-submission retry queue. */
  drainRetryQueue(): Promise<void>;
  /** Step 5 — close the WebSocket and health servers. */
  closeServers(): Promise<void>;
  /** Step 5 — awaited database disconnect (optional). */
  disconnectDatabase?(): Promise<void>;
}

export interface ShutdownOptions {
  /** Bounded deadline for the whole drain phase, in ms. */
  drainDeadlineMs: number;
  /** Hard exit timer armed once shutdown begins; fires with exit code 1. */
  forceExitMs: number;
}

export type ShutdownOutcome =
  | { result: 'drained'; exitCode: 0 }
  | { result: 'deadline-exceeded'; exitCode: 1 };

export class GracefulShutdownCoordinator {
  private hooks: ShutdownHooks;
  private opts: ShutdownOptions;
  private triggered = false;
  private forceExitTimer: NodeJS.Timeout | null = null;

  constructor(hooks: ShutdownHooks, opts: ShutdownOptions) {
    this.hooks = hooks;
    this.opts = opts;
  }

  /**
   * Idempotent signal entrypoint: a second SIGTERM/SIGINT while a drain is
   * already running is logged and ignored instead of restarting the sequence
   * or racing it. Resolves with the shutdown outcome (after `process.exit`,
   * in production the process is gone before this matters).
   */
  handleSignal = (signal: string): Promise<ShutdownOutcome> => {
    if (this.triggered) {
      logger.warn(`[Shutdown] Signal ${signal} received while shutdown already in progress — ignoring`);
      return Promise.resolve({ result: 'deadline-exceeded', exitCode: 1 });
    }
    this.triggered = true;
    logger.info(`[Shutdown] ${signal} received — beginning graceful shutdown (drain deadline ${this.opts.drainDeadlineMs}ms)`);

    this.forceExitTimer = setTimeout(() => {
      logger.error(`[Shutdown] Graceful shutdown exceeded ${this.opts.forceExitMs}ms — forcing exit with code 1`);
      process.exit(1);
    }, this.opts.forceExitMs);

    return this.run()
      .then((outcome) => {
        if (this.forceExitTimer) clearTimeout(this.forceExitTimer);
        logger.info(`[Shutdown] Complete (${outcome.result}); exiting with code ${outcome.exitCode}`);
        process.exit(outcome.exitCode);
        return outcome;
      })
      .catch((err) => {
        if (this.forceExitTimer) clearTimeout(this.forceExitTimer);
        logger.error('[Shutdown] Graceful shutdown failed', err);
        process.exit(1);
        return { result: 'deadline-exceeded', exitCode: 1 };
      });
  };

  register(signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): void {
    for (const signal of signals) {
      process.on(signal, this.handleSignal as never);
    }
  }

  isTriggered(): boolean {
    return this.triggered;
  }

  async run(): Promise<ShutdownOutcome> {
    const deadlineAt = Date.now() + this.opts.drainDeadlineMs;

    this.hooks.flipReadiness();
    this.hooks.stopScheduledWork();

    // The coordinator enforces the drain deadline itself so a hook that
    // forgets to race its own timer cannot hang the shutdown; the force-exit
    // timer remains the backstop of last resort.
    let cycleCompleted: boolean;
    try {
      cycleCompleted = await this.withDeadline(
        this.hooks.waitForInFlightCycle(),
        Math.max(0, deadlineAt - Date.now()),
        'in-flight cycle wait',
      );
    } catch {
      cycleCompleted = false;
    }
    if (!cycleCompleted) {
      logger.error('[Shutdown] In-flight poll cycle did not finish within the drain deadline — skipping queue drain');
      await this.closeQuietly();
      return { result: 'deadline-exceeded', exitCode: 1 };
    }

    const drainBudget = Math.max(0, deadlineAt - Date.now());
    try {
      await this.withDeadline(this.hooks.drainRetryQueue(), drainBudget, 'retry queue drain');
    } catch (err) {
      logger.warn('[Shutdown] Retry queue drain did not complete within budget — continuing shutdown', err);
    }

    await this.closeQuietly();
    return { result: 'drained', exitCode: 0 };
  }

  private async closeQuietly(): Promise<void> {
    try {
      await this.hooks.closeServers();
    } catch (err) {
      logger.warn('[Shutdown] Error closing servers', err);
    }
    if (this.hooks.disconnectDatabase) {
      try {
        await this.withDeadline(this.hooks.disconnectDatabase(), 5_000, 'database disconnect');
      } catch (err) {
        logger.warn('[Shutdown] Database disconnect did not complete in time', err);
      }
    }
  }

  private withDeadline<T>(promise: Promise<T>, budgetMs: number, what: string): Promise<T> {
    if (budgetMs <= 0) {
      return Promise.reject(new Error(`${what} has no remaining budget`));
    }
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${what} exceeded its ${Math.round(budgetMs)}ms budget`)), budgetMs);
      }),
    ]);
  }
}
