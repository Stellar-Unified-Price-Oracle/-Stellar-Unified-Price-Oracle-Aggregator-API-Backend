// Issue #105 — canary deployments for contract upgrades.
//
// Pure, network-free logic for the two off-chain halves of a canary rollout:
//
//   1. Deterministic traffic splitting — given the on-chain canary traffic
//      share (basis points, read from `ProxyContract::get_canary`), decide
//      whether an individual publish goes to the canary implementation or to
//      the canonical one.  Routing is per-submission (a rotating counter), so
//      the share applies across the whole publish stream rather than pinning
//      specific assets to the canary forever.
//
//   2. A failure threshold guard — the publisher records canary submission
//      outcomes and, once consecutive failures reach the configured
//      threshold, signals that the canary must be rolled back (traffic share
//      zeroed on-chain, old implementation untouched).
//
// Kept dependency-free so the unit tests in tests/canary-routing.test.ts run
// without a Soroban network.

export const BPS_DENOMINATOR = 10_000;

/** Deterministic per-submission routing decision.
 *
 * `sequence` is the publisher's global submission counter (monotonically
 * increasing across assets and rounds).  `canaryShareBps` is the on-chain
 * traffic share in basis points (0..10_000).  Returns true when this
 * submission should target the canary implementation.
 */
export function shouldRouteToCanary(sequence: number, canaryShareBps: number): boolean {
  const share = Math.max(0, Math.min(BPS_DENOMINATOR, Math.trunc(canaryShareBps) || 0));
  if (share === 0) return false;
  if (share >= BPS_DENOMINATOR) return true;
  // Split on the sequence number so the share is approximated evenly across
  // the stream: sequence 0..share-1 → canary, share..9999 → canonical,
  // repeating every 10_000 submissions.
  return (sequence % BPS_DENOMINATOR) < share;
}

/** Tracks canary submission outcomes and decides when to roll back.
 *
 * Only *consecutive* failures count (a success resets the streak), so a
 * single transient RPC hiccup cannot trip a rollback by itself.
 */
export class CanaryRollbackGuard {
  private failures = 0;
  private successes = 0;
  private readonly threshold: number;

  constructor(threshold: number) {
    if (!Number.isInteger(threshold) || threshold <= 0) {
      throw new Error(`CanaryRollbackGuard: threshold must be a positive integer, got ${threshold}`);
    }
    this.threshold = threshold;
  }

  /** Record a canary submission outcome.  Returns true if the streak now
   *  crosses the rollback threshold (caller should roll the canary back). */
  recordFailure(): boolean {
    this.failures += 1;
    return this.failures >= this.threshold;
  }

  recordSuccess(): void {
    this.successes += 1;
    this.failures = 0;
  }

  /** Number of consecutive canary failures so far. */
  consecutiveFailures(): number {
    return this.failures;
  }

  /** Total successful canary submissions observed (for observability). */
  totalSuccesses(): number {
    return this.successes;
  }

  shouldRollback(): boolean {
    return this.failures >= this.threshold;
  }
}
