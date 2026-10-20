import { config } from '../infrastructure/config';
import { DriftReport } from './region-price-replicator';
import {
  regionFailbackState,
  regionFailbackTransitionsTotal,
  regionPublisherEpoch,
  regionQuarantineState,
  regionQuarantineTransitionsTotal,
} from '../observability/metrics';

export interface RegionQuarantineStatus {
  region: string;
  quarantined: boolean;
  reason?: string;
  /** Highest publisher epoch observed for this region (local or from peers). */
  epoch: number;
  /** True when a newer epoch from a peer has been observed, so this region must not publish. */
  fenced: boolean;
}

export type RegionQuarantineTransition = 'quarantined' | 'recovered';

export interface RegionQuarantineEvaluation extends RegionQuarantineStatus {
  transition: RegionQuarantineTransition | null;
}

/**
 * Automated failback state machine.
 *
 * stable_primary -> failed_over (quarantine engaged)
 * failed_over -> awaiting_stability (drift back under recover threshold)
 * awaiting_stability -> reconciling (stability window elapsed with no transitions)
 * reconciling -> failing_back (CRDT state reconciled)
 * failing_back -> stable_primary (publisher epoch bumped, authority transferred)
 *
 * Any drift above the alert threshold while not stable_primary returns the
 * machine to failed_over, aborting an in-flight failback.
 */
export type RegionFailbackState =
  | 'stable_primary'
  | 'failed_over'
  | 'awaiting_stability'
  | 'reconciling'
  | 'failing_back';

export interface RegionFailbackStatus {
  region: string;
  state: RegionFailbackState;
  publisherEpoch: number;
  /** Milliseconds the region has been continuously stable, if awaiting stability. */
  stableForMs: number;
  lastTransitionAt: number;
}

export interface RegionFailbackEvaluation extends RegionQuarantineEvaluation {
  failback: RegionFailbackStatus;
  /** Set when this evaluation transferred publishing authority to this region. */
  authorityTransferred: boolean;
}

export interface CrdtReconciler {
  /** Reconcile local CRDT state with peers; resolves true when converged. */
  reconcile(): Promise<boolean>;
}

export interface PublisherEpochStore {
  /** Atomically bump the publisher epoch and return the new value. */
  bumpEpoch(expectedEpoch: number): Promise<number>;
  currentEpoch(): number;
}

export class RegionQuarantineManager {
  private status: RegionQuarantineStatus = {
    region: config.region.id,
    quarantined: false,
    epoch: 0,
    fenced: false,
  };

  private failbackState: RegionFailbackState = 'stable_primary';
  private publisherEpoch = 0;
  private stableSince: number | null = null;
  private lastTransitionAt = Date.now();
  private failbackInFlight = false;

  constructor(
    private readonly reconciler?: CrdtReconciler,
    private readonly epochStore?: PublisherEpochStore,
  ) {}

  async evaluate(report: DriftReport): Promise<RegionFailbackEvaluation> {
    const previous = this.status.quarantined;
    const driftQuarantined = this.nextState(report);
    const feedEvaluations = this.evaluateFeeds(feedSignals);

    const degradedFeeds = feedEvaluations.filter((f) => f.quarantined);
    const quarantined = driftQuarantined || degradedFeeds.length > 0;

    let reason: string | undefined;
    if (quarantined) {
      if (previous && this.status.reason) {
        reason = this.status.reason;
      } else if (driftQuarantined) {
        reason = `drift ${report.maxDriftPercent.toFixed(4)}% exceeds ${config.region.driftAlertPercent}%`;
      } else {
        reason = `feed degradation: ${degradedFeeds
          .map((f) => `${f.feedId} (${f.reason})`)
          .join(', ')}`;
      }
    }

    this.status = quarantined
      ? {
          region: config.region.id,
          quarantined: true,
          reason: previous
            ? this.status.reason
            : `drift ${report.maxDriftPercent.toFixed(4)}% exceeds ${config.region.driftAlertPercent}%`,
          epoch: this.status.epoch,
          fenced: this.status.fenced,
        }
      : {
          region: config.region.id,
          quarantined: false,
          epoch: this.status.epoch,
          fenced: this.status.fenced,
        };

    regionQuarantineState.set({ region: config.region.id }, quarantined ? 1 : 0);
    let transition: RegionQuarantineTransition | null = null;
    if (quarantined !== previous) {
      transition = quarantined ? 'quarantined' : 'recovered';
      regionQuarantineTransitionsTotal.inc({ region: config.region.id, to: transition });
    }

    const authorityTransferred = await this.advanceFailback(report, quarantined);

    return {
      ...this.status,
      transition,
      failback: this.getFailbackStatus(),
      authorityTransferred,
    };
  }

  /**
   * Records a publisher epoch observed for this region. If the observed epoch is
   * higher than the highest epoch seen so far, another publisher has taken over
   * and the local region is fenced: it must refuse to publish until it observes
   * its own epoch as the highest again (e.g. after a fresh election).
   */
  observeEpoch(epoch: number): RegionQuarantineStatus {
    if (!Number.isFinite(epoch) || epoch < 0) return this.status;

    if (epoch > this.status.epoch) {
      this.status = {
        ...this.status,
        epoch,
        fenced: true,
        reason: this.status.quarantined
          ? this.status.reason
          : `observed newer publisher epoch ${epoch}`,
      };
    }
    return this.status;
  }

  /** True when the local region is allowed to publish (not quarantined and not fenced). */
  isAuthoritative(): boolean {
    return !this.status.quarantined && !this.status.fenced;
  }

  getStatus(): RegionQuarantineStatus {
    return this.status;
  }

  getFailbackStatus(): RegionFailbackStatus {
    const now = Date.now();
    return {
      region: config.region.id,
      state: this.failbackState,
      publisherEpoch: this.publisherEpoch,
      stableForMs: this.stableSince === null ? 0 : now - this.stableSince,
      lastTransitionAt: this.lastTransitionAt,
    };
  }

  private async advanceFailback(report: DriftReport, quarantined: boolean): Promise<boolean> {
    if (!config.region.failbackEnabled) return false;

    const now = Date.now();
    const driftAboveAlert = report.maxDriftPercent > config.region.driftAlertPercent;
    const driftStable =
      report.driftKnown && report.maxDriftPercent <= config.region.quarantineRecoverPercent;

    // Any regression aborts an in-flight failback and re-enters failed_over.
    if (quarantined || driftAboveAlert) {
      this.stableSince = null;
      if (this.failbackState !== 'failed_over') {
        this.transitionTo('failed_over', now);
      }
      return false;
    }

    switch (this.failbackState) {
      case 'stable_primary':
        return false;

      case 'failed_over': {
        if (!driftStable) return false;
        this.stableSince = now;
        this.transitionTo('awaiting_stability', now);
        return false;
      }

      case 'awaiting_stability': {
        if (!driftStable) {
          this.stableSince = null;
          this.transitionTo('failed_over', now);
          return false;
        }
        if (this.stableSince === null) this.stableSince = now;
        if (now - this.stableSince < config.region.failbackStabilityWindowMs) return false;
        this.transitionTo('reconciling', now);
        return this.runReconcileAndFailback(now);
      }

      case 'reconciling':
      case 'failing_back':
        // A concurrent evaluation is already driving the failback.
        return this.runReconcileAndFailback(now);
    }
  }

  private async runReconcileAndFailback(now: number): Promise<boolean> {
    if (this.failbackInFlight) return false;
    this.failbackInFlight = true;
    try {
      if (this.failbackState === 'reconciling') {
        const converged = this.reconciler ? await this.reconciler.reconcile() : true;
        if (!converged) {
          // Stay in reconciling; a later evaluation retries.
          return false;
        }
        this.transitionTo('failing_back', Date.now());
      }

      // Atomically bump the publisher epoch before transferring authority so
      // that stale publishers are fenced off and split brain is impossible.
      const expected = this.epochStore ? this.epochStore.currentEpoch() : this.publisherEpoch;
      const nextEpoch = this.epochStore
        ? await this.epochStore.bumpEpoch(expected)
        : this.publisherEpoch + 1;
      this.publisherEpoch = nextEpoch;
      regionPublisherEpoch.set({ region: config.region.id }, nextEpoch);

      this.stableSince = null;
      this.transitionTo('stable_primary', Date.now());
      return true;
    } finally {
      this.failbackInFlight = false;
    }
  }

  private transitionTo(next: RegionFailbackState, now: number): void {
    if (this.failbackState === next) return;
    const from = this.failbackState;
    this.failbackState = next;
    this.lastTransitionAt = now;
    regionFailbackState.set({ region: config.region.id }, failbackStateValue(next));
    regionFailbackTransitionsTotal.inc({ region: config.region.id, from, to: next });
  }

  private nextState(report: DriftReport): boolean {
    if (!config.region.quarantineEnabled) return false;

    if (report.maxDriftPercent > config.region.driftAlertPercent) return true;

    const recovered =
      report.driftKnown && report.maxDriftPercent <= config.region.quarantineRecoverPercent;
    return this.status.quarantined && !recovered;
  }
}

function failbackStateValue(state: RegionFailbackState): number {
  switch (state) {
    case 'stable_primary':
      return 0;
    case 'failed_over':
      return 1;
    case 'awaiting_stability':
      return 2;
    case 'reconciling':
      return 3;
    case 'failing_back':
      return 4;
  }
}
