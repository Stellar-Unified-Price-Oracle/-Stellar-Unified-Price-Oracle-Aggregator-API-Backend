import {
  Account,
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';
import {
  canaryActive,
  canaryConsecutiveFailures,
  canaryRollbacksTotal,
  canarySubmissionsTotal,
  canaryTrafficShareBps,
  contractSubmissionGas,
  contractSubmissionGasTotal,
  contractRpcCallsTotal,
  contractRpcCallsPerRound,
  contractSubmissionsTotal,
  contractBatchRoundFeesTotal,
  contractBatchRoundTransactions,
  contractSubmissionOutcome,
  contractOutcomeFailureRatio,
  contractOutcomeTotalWindow,
  contractOutcomeFailedWindow,
} from '../observability/metrics';
import { AggregatedPrice } from '../infrastructure/types';
import { CanaryRollbackGuard, shouldRouteToCanary } from './canary';
import { SubmissionRetryQueue } from './retry-queue';
import { MerkleTree, BatchPriceEntry } from '../infrastructure/merkle';
import { FencingEpochStore, FencingEpochState } from './fencing-epoch';

interface ContractCallLog {
  txHash: string;
  function: string;
  asset: string;
  params: Record<string, unknown>;
  simulationFee?: string;
  actualFee?: string;
  status: 'success' | 'failed' | 'simulation_failed' | 'source_quality_rejected';
  error?: string;
  durationMs: number;
  timestamp: number;
}

interface GasAlert {
  txHash: string;
  function: string;
  fee: number;
  threshold: number;
}

/**
 * Fields of the Soroban RPC simulate response read by the publisher.
 */
interface SimulateResponse {
  minResourceFee?: string;
  cost?: { feeCharged?: string; cpuInsns?: string; memBytes?: string };
  results?: unknown[];
  error?: unknown;
  result?: { retval?: xdr.ScVal };
  id?: string;
  latestLedger?: number;
}

/** Fields of the Soroban RPC send response read by the publisher. */
interface SendResponse {
  fee?: string;
  status?: string;
  hash?: string;
  errorResultXdr?: string;
}

/** Fields of the Soroban RPC getTransaction response read by the publisher. */
interface GetTransactionResponse {
  status?: string;
  resultMetaXdr?: unknown;
}

// Issue #576 — non-retryable contract error codes.
//
// These on-chain rejection codes indicate a logic-level rejection (wrong
// source, contract paused, price deviation).  Retrying immediately or with
// backoff cannot make them succeed, so they must be routed to a dead-letter
// path instead of the standard retry queue.
const NON_RETRYABLE_CONTRACT_ERRORS = new Set([
  'UnauthorizedSource',
  'ContractPaused',
  'PriceDeviationTooLarge',
  'InvalidPrice',
  'InvalidDecimals',
  'NotWhitelisted',
]);

// Issue #726 — feature flag for the stable snapshot read interface.
//
// Rollout: set CONTRACT_SNAPSHOT_READS_ENABLED=true to make the publisher read
// `get_price_snapshot` (a single mutually-consistent view of price, timestamps
// and policy version) instead of the legacy multi-read path.  The flag
// defaults to off so the change can be rolled out per region.
//
// Rollback: set the flag back to false (or unset it) and restart.  The legacy
// `get_price` / `get_on_chain_timestamp` reads remain in place and are used
// whenever the flag is off or the snapshot read fails, so no state migration
// is required.  Monitor `contract_rpc_calls_total{call_type="simulate"}` and
// the `snapshot_read_fallback` log line to confirm the active path.
const SNAPSHOT_READS_ENABLED = process.env.CONTRACT_SNAPSHOT_READS_ENABLED === 'true';

// Issue #726 — policy version reported by the contract when the snapshot
// interface is unavailable (legacy deployments).
const LEGACY_POLICY_VERSION = 0;

// Maximum number of getTransaction polls before declaring a timeout.
const TX_POLL_RETRIES = parseInt(process.env.TX_POLL_RETRIES || '20', 10);
// Milliseconds between each getTransaction poll.
const TX_POLL_INTERVAL_MS = parseInt(process.env.TX_POLL_INTERVAL_MS || '2000', 10);

const GAS_ALERT_THRESHOLD = parseInt(process.env.CONTRACT_GAS_ALERT_THRESHOLD || '50000', 10);

// Sliding-window state for the outcome failure-ratio metric (issue #576).
// Keyed by function name so each entrypoint has an independent ratio.
const outcomeWindow: Map<string, { total: number; failed: number }> = new Map();

function recordOutcome(fnName: string, outcome: 'success' | 'failed' | 'timeout' | 'not_found'): void {
  const current = outcomeWindow.get(fnName) ?? { total: 0, failed: 0 };
  current.total += 1;
  if (outcome !== 'success') {
    current.failed += 1;
  }
  outcomeWindow.set(fnName, current);
  const ratio = current.total > 0 ? current.failed / current.total : 0;
  contractOutcomeFailureRatio.set({ function: fnName }, ratio);
  contractOutcomeTotalWindow.set({ function: fnName }, current.total);
  contractOutcomeFailedWindow.set({ function: fnName }, current.failed);
}

/**
 * Issue #576 — poll getTransaction until a terminal status is returned or
 * TX_POLL_RETRIES is exhausted.
 *
 * Returns one of:
 *   'SUCCESS'   — transaction included and succeeded on-chain
 *   'FAILED'    — transaction included but failed on-chain
 *   'NOT_FOUND' — transaction never included within the poll window (timeout)
 *
 * A NOT_FOUND after all retries is logged as 'timeout' in metrics to
 * distinguish "never seen" from "still pending".
 */
async function pollForOutcome(
  server: SorobanRpc.Server,
  txHash: string,
): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; response: GetTransactionResponse }> {
  for (let i = 0; i < TX_POLL_RETRIES; i++) {
    await new Promise((resolve) => setTimeout(resolve, TX_POLL_INTERVAL_MS));
    try {
      const response: GetTransactionResponse = await server.getTransaction(txHash);
      const status = response?.status;
      if (status === 'SUCCESS' || status === 'FAILED') {
        return { status, response };
      }
      // NOT_FOUND means still pending — keep polling.
    } catch (err) {
      logger.warn(`[Contract] getTransaction poll error for ${txHash}`, {
        attempt: i + 1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { status: 'NOT_FOUND', response: {} };
}

/**
 * Inspect the resultMetaXdr of a FAILED transaction to extract the contract
 * error name (e.g. "UnauthorizedSource") if present. Returns null when the
 * error cannot be decoded.
 */
function extractContractErrorName(resultMetaXdr: unknown): string | null {
  try {
    let meta: xdr.TransactionMeta;
    if (typeof resultMetaXdr === 'string') {
      meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
    } else if (Buffer.isBuffer(resultMetaXdr)) {
      meta = xdr.TransactionMeta.fromXDR(resultMetaXdr);
    } else {
      return null;
    }
    if (meta.switch() !== 3) return null;
    const sorobanMeta = meta.v3().sorobanMeta();
    const returnValue = sorobanMeta?.returnValue();
    if (!returnValue) return null;
    const native = scValToNative(returnValue);
    if (typeof native === 'object' && native !== null && 'Err' in native) {
      const err = (native as { Err: unknown }).Err;
      if (typeof err === 'string') return err;
      if (typeof err === 'object' && err !== null) {
        const keys = Object.keys(err);
        if (keys.length > 0) return keys[0];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Issue #726 — mutually consistent read view returned by `get_price_snapshot`.
 *
 * All fields are read in a single simulation, so a consumer can rely on
 * `price`, `timestamp` and `policyVersion` describing the same ledger state.
 */
export interface PriceSnapshot {
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  /** Ledger sequence at which the snapshot was produced. */
  ledger: number;
  /** Version of the on-chain pricing policy in force for this snapshot. */
  policyVersion: number;
  /** Whether the value came from the snapshot read or the legacy fallback. */
  source: 'snapshot' | 'legacy';
}

/**
 * Issue #724 — consumer-verifiable evidence for a published price.
 *
 * Trust assumptions:
 *   - The evidence is only as trustworthy as the contract id and network
 *     passphrase it was produced against; consumers MUST pin both.
 *   - `txHash` identifies the transaction that committed the price; a
 *     consumer verifies it against the ledger via `getTransaction`.
 *   - `snapshot` is the read view observed by the publisher at publish time;
 *     it is advisory and must be re-read by the consumer to detect drift.
 *
 * Failure cases a consumer must handle:
 *   - Missing/unknown `txHash` (transaction not yet included or pruned).
 *   - `snapshot` older than the consumer's staleness threshold.
 *   - `policyVersion` newer than the consumer supports.
 */
export interface PriceEvidence {
  asset: string;
  price: string;
  decimals: number;
  timestamp: number;
  txHash: string;
  contractId: string;
  networkPassphrase: string;
  policyVersion: number;
  ledger: number;
  /** Schema version of this evidence payload. */
  evidenceVersion: number;
}

/** Current evidence schema version emitted by the publisher (Issue #724). */
export const PRICE_EVIDENCE_VERSION = 1;

/** Fee policy configuration for Soroban transactions (Issue #578) */
export interface FeePolicy {
  baseInclusionFee: number;
  surgeMultiplier: number;
  maxInclusionFee: number;
  maxResourceFee: number;
}

export const DEFAULT_FEE_POLICY: FeePolicy = {
  baseInclusionFee: parseInt(process.env.CONTRACT_BASE_INCLUSION_FEE || '100', 10),
  surgeMultiplier: parseFloat(process.env.CONTRACT_FEE_SURGE_MULTIPLIER || '1.2'),
  maxInclusionFee: parseInt(process.env.CONTRACT_MAX_INCLUSION_FEE || '50000', 10),
  maxResourceFee: parseInt(process.env.CONTRACT_MAX_RESOURCE_FEE || '1000000', 10),
};

function emitContractLog(entry: ContractCallLog): void {
  const level = entry.status === 'success' ? 'info' : 'error';
  logger.log(level, `[Contract] ${entry.function} ${entry.asset} — ${entry.status}`, {
    txHash: entry.txHash,
    function: entry.function,
    asset: entry.asset,
    params: entry.params,
    simulationFee: entry.simulationFee,
    actualFee: entry.actualFee,
    durationMs: entry.durationMs,
    error: entry.error,
  });
}

function checkGasAlert(alert: GasAlert): void {
  logger.warn(`[Contract] High gas usage detected for ${alert.function}`, {
    txHash: alert.txHash,
    function: alert.function,
    fee: alert.fee,
    threshold: alert.threshold,
  });
}

function isBadSeqError(err: unknown): boolean {
  if (!err) return false;
  const str = typeof err === 'object' ? JSON.stringify(err) : String(err);
  return /tx_bad_seq|bad.?seq|txBadSeq/i.test(str);
}

export class ContractPublisher {
  private server: SorobanRpc.Server;
  private keypair: Keypair;
  private contractId: string;
  private networkPassphrase: string;
  private retryQueue: SubmissionRetryQueue;
  private feePolicy: FeePolicy;
  private publishingEnabled = true;

  // Cached account for sequence bumping across transactions (Issue #578)
  private cachedAccount: Account | null = null;

  // Track RPC calls per round to measure RPC reduction (Issue #578)
  private roundRpcCounts = {
    getAccount: 0,
    simulate: 0,
    send: 0,
    getTransaction: 0,
  };

  // Canary deployment state (Issue #105, #574)
  private canaryContractId: string | null = null;
  private canaryShareBps = 0;
  private submissionSequence = 0;
  private canaryRollbackGuard: CanaryRollbackGuard;

  // Issue #745 — single-publisher fencing epoch.  Every submission carries
  // the epoch this publisher believes is authoritative; the contract rejects
  // anything below its own epoch, so a stale or isolated region cannot write
  // after failover.  The epoch is persisted so a restarted process resumes
  // with the same authority instead of silently regressing.
  private fencingEpochStore: FencingEpochStore;
  private fencingEpoch = 0;

  constructor(feePolicy: Partial<FeePolicy> = {}, fencingEpochStore?: FencingEpochStore) {
    this.server = new SorobanRpc.Server(config.soroban.rpcUrl);
    this.keypair = Keypair.fromSecret(config.soroban.adminSecret);
    this.contractId = config.soroban.contractId;
    this.networkPassphrase = config.soroban.networkPassphrase;
    this.feePolicy = { ...DEFAULT_FEE_POLICY, ...feePolicy };
    this.canaryRollbackGuard = new CanaryRollbackGuard(config.canary.failureThreshold);
    this.fencingEpochStore = fencingEpochStore ?? new FencingEpochStore();
    this.fencingEpoch = this.fencingEpochStore.load().epoch;

    this.retryQueue = new SubmissionRetryQueue({
      maxRetries: 5,
      baseBackoffMs: 1000,
      maxBackoffMs: 60000,
    });

    this.retryQueue.on('retry', (data) => {
      logger.info(`[Publisher] Retrying submission for ${data.submission.asset}`, {
        attemptCount: data.attemptCount,
        nextRetryKey: data.key,
      });
    });

    this.retryQueue.on('failure', (data) => {
      logger.error(`[Publisher] Submission permanently failed for ${data.submission.asset}`, {
        key: data.key,
        reason: data.reason,
        attemptCount: data.submission.attemptCount,
      });
    });

    this.retryQueue.start();
  }

  isPublishingEnabled(): boolean {
    return this.publishingEnabled;
  }

  /** Issue #745 — the epoch this publisher currently claims authority for. */
  getFencingEpoch(): number {
    return this.fencingEpoch;
  }

  /**
   * Issue #745 — advance the fencing epoch on leader election.
   *
   * The new epoch is persisted before it is adopted so a crash mid-promotion
   * cannot leave the process believing it holds an older epoch than the one
   * recorded on disk.  Queued submissions from the previous epoch are
   * discarded: they were produced under authority that is no longer valid and
   * must be re-aggregated by the new leader rather than replayed.
   */
  async advanceFencingEpoch(reason = 'leader_election'): Promise<number> {
    const previous = this.fencingEpoch;
    const next = previous + 1;
    const state: FencingEpochState = {
      epoch: next,
      updatedAt: Date.now(),
      reason,
    };
    this.fencingEpochStore.save(state);
    this.fencingEpoch = next;

    const discarded = this.retryQueue.getQueueSize();
    if (discarded > 0) {
      this.retryQueue.discardAll(`fencing_epoch_advanced:${previous}->${next}`);
    }

    logger.warn('[Publisher] Fencing epoch advanced on leader election', {
      previousEpoch: previous,
      epoch: next,
      reason,
      discardedSubmissions: discarded,
    });
    return next;
  }

  /**
   * Issue #745 — reject submissions whose epoch is not the current
   * authoritative epoch.  Returns true when the submission may proceed.
   */
  private admitEpoch(epoch: number | undefined, asset: string): boolean {
    const claimed = epoch ?? this.fencingEpoch;
    if (claimed === this.fencingEpoch) return true;

    contractSubmissionsTotal.inc({ path: 'fenced', status: 'stale_epoch' });
    logger.warn('[Publisher] Rejected submission from stale fencing epoch', {
      asset,
      claimedEpoch: claimed,
      currentEpoch: this.fencingEpoch,
    });
    return false;
  }

  /**
   * Issues #737, #738 — attach (or replace) the feed ownership registry used
   * to gate submissions. When no registry is configured the publisher keeps
   * its legacy behaviour and publishes unconditionally.
   */
  setOwnershipRegistry(registry: FeedOwnershipRegistry | null): void {
    this.ownershipRegistry = registry;
  }

  /**
   * Issues #737, #738 — decide whether this region may publish the given feed
   * right now. Returns `{ allowed: true }` when no registry is configured.
   *
   * A feed is publishable only when:
   *   - this region is the current owner, and
   *   - the local epoch matches the latest committed epoch, and
   *   - no authority transfer (failover/failback) is in progress.
   */
  private checkFeedAuthority(asset: string): OwnershipDecision {
    if (!this.ownershipRegistry) {
      return { allowed: true };
    }
    return this.ownershipRegistry.canPublish(asset);
  }

  /**
   * Issues #737, #738 — log and drop a submission that this region is not
   * authorized to make. Never enqueues a retry: the owning region is
   * responsible for the feed, and retrying here would risk split brain.
   */
  private rejectUnauthorizedSubmission(asset: string, decision: OwnershipDecision): null {
    logger.warn('[Publisher] Skipping submission: region not authorized for feed', {
      asset,
      region: this.ownershipRegistry?.getLocalRegion(),
      reason: decision.reason,
      ownerRegion: decision.ownerRegion,
      localEpoch: decision.localEpoch,
      latestEpoch: decision.latestEpoch,
      transferInProgress: decision.transferInProgress,
    });
    return null;
  }

  /**
   * Issue #580 — gate every contract write behind the region quarantine.
   * Disabling stops the retry processor and discards the retry queue as
   * orphaned, so nothing queued before the boundary can be flushed after the
   * region recovers. Enabling resumes the processor; the next poll round
   * republishes the current aggregate from scratch.
   */
  setPublishingEnabled(enabled: boolean, reason = 'quarantine'): void {
    if (this.publishingEnabled === enabled) return;
    const queued = this.retryQueue.getQueueSize();
    this.publishingEnabled = enabled;
    this.retryQueue.setSuspended(!enabled, reason);
    if (enabled) {
      logger.info('[Publisher] Contract publication resumed', { reason });
    } else {
      logger.warn('[Publisher] Contract publication suspended; retry queue discarded', {
        reason,
        orphaned: queued,
      });
    }
  }

  private recordRpcCall(callType: 'get_account' | 'simulate' | 'send' | 'get_transaction'): void {
    contractRpcCallsTotal.inc({ call_type: callType });
    if (callType === 'get_account') this.roundRpcCounts.getAccount++;
    else if (callType === 'simulate') this.roundRpcCounts.simulate++;
    else if (callType === 'send') this.roundRpcCounts.send++;
    else if (callType === 'get_transaction') this.roundRpcCounts.getTransaction++;
  }

  resetRoundRpcMetrics(): void {
    this.roundRpcCounts = {
      getAccount: 0,
      simulate: 0,
      send: 0,
      getTransaction: 0,
    };
  }

  flushRoundRpcMetrics(): void {
    contractRpcCallsPerRound.set({ call_type: 'get_account' }, this.roundRpcCounts.getAccount);
    contractRpcCallsPerRound.set({ call_type: 'simulate' }, this.roundRpcCounts.simulate);
    contractRpcCallsPerRound.set({ call_type: 'send' }, this.roundRpcCounts.send);
    contractRpcCallsPerRound.set({ call_type: 'get_transaction' }, this.roundRpcCounts.getTransaction);
    logger.debug('[Publisher] RPC call counts for round', this.roundRpcCounts);
  }

  getRoundRpcMetrics() {
    return { ...this.roundRpcCounts };
  }

  /**
   * Acquire or refresh the local Account object. Caches the sequence and bumps
   * it locally per submitted transaction to eliminate redundant RPC lookups.
   */
  async getAccount(forceRefresh = false): Promise<Account> {
    if (forceRefresh || !this.cachedAccount) {
      this.recordRpcCall('get_account');
      this.cachedAccount = await this.server.getAccount(this.keypair.publicKey());
      logger.debug(`[Publisher] Loaded account sequence ${this.cachedAccount.sequenceNumber()} for ${this.keypair.publicKey()}`);
    }
    return this.cachedAccount;
  }

  private calculateInclusionFee(): string {
    const multiplier = Math.max(1.0, Math.min(this.feePolicy.surgeMultiplier, 3.0));
    const calculated = Math.floor(this.feePolicy.baseInclusionFee * multiplier);
    const bounded = Math.min(calculated, this.feePolicy.maxInclusionFee);
    return String(bounded);
  }

  // ── Individual submission ──────────────────────────────────────────────────

  async submitPrice(
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
    epoch?: number,
  ): Promise<string | null> {
    return this.submitPriceTo(this.contractId, asset, price, decimals, timestamp, false, epoch);
  }

  /** Send one submission to a specific contract id with bad-sequence recovery */
  private async submitPriceTo(
    targetContractId: string,
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
    isRetry = false,
    epoch?: number,
  ): Promise<string | null> {
    if (!this.admitEpoch(epoch, asset)) {
      return null;
    }

    const startMs = Date.now();
    const fnName = 'submit_price';
    const params = { asset, price: price.toString(), decimals, timestamp, epoch: this.fencingEpoch };

    let txHash = '';
    try {
      const account = await this.getAccount();
      const fee = this.calculateInclusionFee();

      const tx = new TransactionBuilder(account, {
        fee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: targetContractId,
            function: fnName,
            args: [
              nativeToScVal(this.keypair.publicKey(), { type: 'address' }),
              nativeToScVal(asset, { type: 'string' }),
              nativeToScVal(price, { type: 'i128' }),
              nativeToScVal(decimals, { type: 'u32' }),
              nativeToScVal(timestamp, { type: 'u64' }),
              nativeToScVal(this.fencingEpoch, { type: 'u32' }),
            ],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
      txHash = tx.hash().toString('hex');

      this.recordRpcCall('simulate');
      const simulateResponse: SimulateResponse = await this.server.simulateTransaction(tx);
      const simulationFee =
        simulateResponse?.minResourceFee ?? simulateResponse?.cost?.feeCharged ?? 'unknown';

      logger.debug(`[Contract] Simulation result for ${fnName} ${asset}`, {
        txHash,
        minResourceFee: simulateResponse?.minResourceFee,
        cost: simulateResponse?.cost,
        results: simulateResponse?.results?.length ?? 0,
      });

      if (simulateResponse.error) {
        const errorStr = String(simulateResponse.error);
        const isInvalidDecimals = errorStr.includes('InvalidDecimals') || errorStr.includes('Error(Contract, #5)');
        const status = isInvalidDecimals ? 'source_quality_rejected' : 'simulation_failed';

        emitContractLog({
          txHash,
          function: fnName,
          asset,
          params,
          simulationFee: String(simulationFee),
          status,
          error: errorStr,
          durationMs: Date.now() - startMs,
          timestamp: Math.floor(Date.now() / 1000),
        });

        if (isInvalidDecimals) {
          logger.warn(`[Contract] Price submission rejected for ${asset} due to source quality issue (InvalidDecimals scale): ${errorStr}`, {
            asset,
            decimals,
            price: price.toString(),
          });
        }
        return null;
      }

      // Check whether simulation minResourceFee is far above our maxResourceFee threshold
      if (simulationFee !== 'unknown') {
        const resourceFeeNum = parseInt(String(simulationFee), 10);
        if (!isNaN(resourceFeeNum) && resourceFeeNum > this.feePolicy.maxResourceFee) {
          logger.error(`[Contract] Simulation minResourceFee ${resourceFeeNum} exceeds maxResourceFee limit ${this.feePolicy.maxResourceFee} for ${asset}`);
          emitContractLog({
            txHash,
            function: fnName,
            asset,
            params,
            simulationFee: String(simulationFee),
            status: 'simulation_failed',
            error: `minResourceFee (${resourceFeeNum}) exceeds maxResourceFee (${this.feePolicy.maxResourceFee})`,
            durationMs: Date.now() - startMs,
            timestamp: Math.floor(Date.now() / 1000),
          });
          return null;
        }
      }

      this.recordRpcCall('send');
      const sendResponse: SendResponse = await this.server.sendTransaction(tx);

      // Handle bad-sequence error response
      if (sendResponse?.status === 'ERROR' && isBadSeqError(sendResponse)) {
        if (!isRetry) {
          logger.warn(`[Contract] tx_bad_seq reported from sendTransaction for ${asset}. Resyncing account and retrying once...`);
          await this.getAccount(true);
          return this.submitPriceTo(targetContractId, asset, price, decimals, timestamp, true, epoch);
        }
      }

      const actualFee = sendResponse?.fee ?? simulationFee;
      const feeNum = parseInt(String(actualFee), 10);

      if (!Number.isNaN(feeNum)) {
        contractSubmissionGas.observe({ function: fnName, asset, status: 'pending' }, feeNum);
        contractSubmissionGasTotal.inc({ function: fnName, asset, status: 'pending' }, feeNum);
      }

      if (!Number.isNaN(feeNum) && feeNum > GAS_ALERT_THRESHOLD) {
        checkGasAlert({ txHash, function: fnName, fee: feeNum, threshold: GAS_ALERT_THRESHOLD });
      }

      // Poll until SUCCESS, FAILED, or timeout.
      logger.debug(`[Contract] Polling getTransaction for ${txHash}`);
      const { status: txStatus, response: txResponse } = await pollForOutcome(this.server, txHash);

      if (txStatus === 'SUCCESS') {
        contractSubmissionOutcome.inc({ function: fnName, asset, outcome: 'success' });
        recordOutcome(fnName, 'success');

        emitContractLog({
          txHash,
          function: fnName,
          asset,
          params,
          simulationFee: String(simulationFee),
          actualFee: String(actualFee),
          status: 'success',
          durationMs: Date.now() - startMs,
          timestamp: Math.floor(Date.now() / 1000),
        });

        await this.captureContractEvents(txHash, txResponse);

        // Issue #724/#726 — attach evidence and emit the versioned snapshot
        // event for the confirmed publish.
        const evidence = this.buildPriceEvidence(asset, price, decimals, timestamp, txHash);
        logger.info('[Contract] price_evidence', { evidence });
        this.emitSnapshotEvent(asset, txHash);

        return txHash;
      }

      // FAILED or NOT_FOUND (timeout).
      const outcome = txStatus === 'FAILED' ? 'failed' : 'timeout';
      const contractErrorName = txStatus === 'FAILED'
        ? extractContractErrorName(txResponse?.resultMetaXdr)
        : null;

      contractSubmissionOutcome.inc({ function: fnName, asset, outcome });
      recordOutcome(fnName, outcome === 'timeout' ? 'timeout' : 'failed');

      logger.error(`[Contract] Submission ${outcome} for ${asset}`, {
        txHash,
        outcome,
        contractError: contractErrorName,
        durationMs: Date.now() - startMs,
      });

      emitContractLog({
        txHash,
        function: fnName,
        asset,
        params,
        simulationFee: String(simulationFee),
        actualFee: String(actualFee),
        status: 'failed',
        error: contractErrorName ?? outcome,
        durationMs: Date.now() - startMs,
        timestamp: Math.floor(Date.now() / 1000),
      });

      // Issue #576 — non-retryable contract errors (wrong source, paused,
      // deviation) must not be queued for retry; doing so would hot-loop.
      // Retryable failures (timeout, not_found, transient on-chain errors)
      // are enqueued normally.
      const isNonRetryable =
        contractErrorName !== null && NON_RETRYABLE_CONTRACT_ERRORS.has(contractErrorName);

      if (isNonRetryable) {
        logger.warn(
          `[Publisher] Non-retryable contract error '${contractErrorName}' for ${asset} — skipping retry queue`,
          { txHash, contractErrorName },
        );
      } else {
        this.retryQueue.enqueue({ asset, price, decimals, timestamp, epoch: this.fencingEpoch });
      }

      return null;
    } catch (err) {
      if (!isRetry && isBadSeqError(err)) {
        logger.warn(`[Contract] tx_bad_seq exception for ${asset}. Resyncing sequence and retrying once...`);
        try {
          await this.getAccount(true);
          return this.submitPriceTo(targetContractId, asset, price, decimals, timestamp, true, epoch);
        } catch (resyncErr) {
          logger.error(`[Contract] Failed to resync account after tx_bad_seq: ${resyncErr}`);
        }
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      const isInvalidDecimals = errMsg.includes('InvalidDecimals') || errMsg.includes('Error(Contract, #5)');
      const isNonRetryable = isInvalidDecimals || errMsg.includes('ContractPaused') || errMsg.includes('Error(Contract, #33)');

      emitContractLog({
        txHash: txHash || 'unknown',
        function: fnName,
        asset,
        params,
        status: isInvalidDecimals ? 'source_quality_rejected' : 'failed',
        error: errMsg,
        durationMs: Date.now() - startMs,
        timestamp: Math.floor(Date.now() / 1000),
      });

      if (isInvalidDecimals) {
        logger.warn(`[Contract] Non-retryable source quality failure for ${asset}: InvalidDecimals rejected by contract: ${errMsg}`, {
          asset,
          decimals,
          price: price.toString(),
          txHash,
        });
      } else {
        logger.error(`[Contract] Failed to submit ${asset}: ${errMsg}`, { txHash });
      }

      if (!isNonRetryable) {
        this.retryQueue.enqueue({
          asset,
          price,
          decimals,
          timestamp,
          epoch: this.fencingEpoch,
        });
      }

      return null;
    }
  }

  /**
   * Issue #726 — read a mutually consistent snapshot of price, timestamps and
   * policy version in a single simulation via `get_price_snapshot`.
   *
   * Returns null when the snapshot interface is unavailable or the read
   * fails; callers fall back to the legacy multi-read path.
   */
  async getPriceSnapshot(asset: string): Promise<PriceSnapshot | null> {
    if (!SNAPSHOT_READS_ENABLED) return null;
    try {
      const dummyAccount = new Account(this.keypair.publicKey(), '0');
      const tx = new TransactionBuilder(dummyAccount, {
        fee: this.calculateInclusionFee(),
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'get_price_snapshot',
            args: [
              nativeToScVal(this.keypair.publicKey(), { type: 'address' }),
              nativeToScVal(asset, { type: 'string' }),
            ],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
      this.recordRpcCall('simulate');
      const simulateResponse: SimulateResponse = await this.server.simulateTransaction(tx);
      if (simulateResponse.error || !simulateResponse.result?.retval) {
        logger.warn('[Contract] get_price_snapshot unavailable, using legacy reads', {
          asset,
          error: simulateResponse.error ? String(simulateResponse.error) : 'no retval',
        });
        return null;
      }

      const decoded = scValToNative(simulateResponse.result.retval) as
        | Record<string, unknown>
        | undefined;
      if (!decoded || decoded.price === undefined || decoded.timestamp === undefined) {
        return null;
      }

      const snapshot: PriceSnapshot = {
        asset,
        price: BigInt(decoded.price as string | number | bigint),
        decimals: Number(decoded.decimals ?? 0),
        timestamp: Number(decoded.timestamp),
        ledger: Number(decoded.ledger ?? 0),
        policyVersion: Number(decoded.policy_version ?? LEGACY_POLICY_VERSION),
        source: 'snapshot',
      };
      this.lastSnapshots.set(asset, snapshot);
      return snapshot;
    } catch (err) {
      logger.warn('[Contract] get_price_snapshot failed, using legacy reads', {
        asset,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Issue #726 — obtain a consistent read view for an asset, preferring the
   * snapshot interface and falling back to the legacy multi-read path.
   */
  async readPriceSnapshot(asset: string): Promise<PriceSnapshot | null> {
    const snapshot = await this.getPriceSnapshot(asset);
    if (snapshot) return snapshot;

    const timestamp = await this.getOnChainTimestamp(asset);
    if (timestamp === null) return null;

    const legacy: PriceSnapshot = {
      asset,
      price: 0n,
      decimals: 0,
      timestamp,
      ledger: 0,
      policyVersion: LEGACY_POLICY_VERSION,
      source: 'legacy',
    };
    this.lastSnapshots.set(asset, legacy);
    return legacy;
  }

  /**
   * Issue #724 — build a consumer-verifiable evidence payload for a published
   * price.  Consumers pin `contractId` + `networkPassphrase`, verify `txHash`
   * on-ledger, and re-read the snapshot to detect drift.
   */
  buildPriceEvidence(
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
    txHash: string,
  ): PriceEvidence {
    const snapshot = this.lastSnapshots.get(asset);
    return {
      asset,
      price: price.toString(),
      decimals,
      timestamp,
      txHash,
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
      policyVersion: snapshot?.policyVersion ?? LEGACY_POLICY_VERSION,
      ledger: snapshot?.ledger ?? 0,
      evidenceVersion: PRICE_EVIDENCE_VERSION,
    };
  }

  /**
   * Issue #726 — emit the versioned snapshot event after a successful publish
   * so downstream consumers can observe the consistent read view.
   */
  private emitSnapshotEvent(asset: string, txHash: string): void {
    const snapshot = this.lastSnapshots.get(asset);
    if (!snapshot) return;
    logger.info('[Contract] price_snapshot', {
      event: 'price_snapshot',
      eventVersion: PRICE_EVIDENCE_VERSION,
      asset,
      price: snapshot.price.toString(),
      decimals: snapshot.decimals,
      timestamp: snapshot.timestamp,
      ledger: snapshot.ledger,
      policyVersion: snapshot.policyVersion,
      source: snapshot.source,
      txHash,
    });
  }

  // Issue #382, #578 — on-chain price staleness heartbeat without redundant getAccount lookups.
  async getOnChainTimestamp(asset: string): Promise<number | null> {
    try {
      // Re-use mock Account structure so read-only simulation never triggers getAccount calls
      const dummyAccount = new Account(this.keypair.publicKey(), '0');
      const tx = new TransactionBuilder(dummyAccount, {
        fee: this.calculateInclusionFee(),
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'get_price',
            args: [
              nativeToScVal(this.keypair.publicKey(), { type: 'address' }),
              nativeToScVal(asset, { type: 'string' }),
            ],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
      this.recordRpcCall('simulate');
      const simulateResponse: SimulateResponse = await this.server.simulateTransaction(tx);
      if (simulateResponse.error || !simulateResponse.result?.retval) {
        return null;
      }

      const decoded = scValToNative(simulateResponse.result.retval) as
        | { timestamp?: unknown }
        | undefined;
      if (decoded === undefined || decoded === null || decoded.timestamp === undefined) {
        return null;
      }
      return Number(decoded.timestamp);
    } catch (err) {
      logger.warn(`[Contract] Failed to read on-chain timestamp for ${asset}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // Issue #576 — captureContractEvents is now called only after a confirmed
  // SUCCESS status from getTransaction, so the response already contains the
  // inclusion meta.  The response is passed in rather than re-fetched.
  private async captureContractEvents(
    txHash: string,
    txResponse: GetTransactionResponse,
  ): Promise<void> {
    try {
      this.recordRpcCall('get_transaction');
      const response: GetTransactionResponse = await this.server.getTransaction(txHash);
      if (!response || response.status === 'NOT_FOUND') return;

      const events: xdr.DiagnosticEvent[] = txResponse?.resultMetaXdr
        ? this.extractEvents(txResponse.resultMetaXdr)
        : [];

      for (const event of events) {
        const eventType = this.parseEventType(event);
        logger.info(`[Contract] Event captured: ${eventType}`, { txHash, eventType });
      }

      if (events.length > 0) {
        logger.info(`[Contract] Captured ${events.length} event(s) from tx ${txHash}`);
      }
    } catch (err) {
      logger.debug(
        `[Contract] Could not capture events for ${txHash}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private extractEvents(resultMetaXdr: unknown): xdr.DiagnosticEvent[] {
    if (Array.isArray(resultMetaXdr)) {
      return resultMetaXdr.filter(
        (event): event is xdr.DiagnosticEvent => xdr.DiagnosticEvent.isValid(event),
      );
    }

    let meta: xdr.TransactionMeta;
    if (typeof resultMetaXdr === 'string') {
      meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
    } else if (Buffer.isBuffer(resultMetaXdr)) {
      meta = xdr.TransactionMeta.fromXDR(resultMetaXdr);
    } else if (xdr.TransactionMeta.isValid(resultMetaXdr as xdr.TransactionMeta)) {
      meta = resultMetaXdr as xdr.TransactionMeta;
    } else {
      return [];
    }

    if (meta.switch() !== 3) return [];

    const sorobanMeta = meta.v3().sorobanMeta();
    return sorobanMeta?.diagnosticEvents() ?? [];
  }

  private parseEventType(event: xdr.DiagnosticEvent): string {
    const contractEvent = event.event();
    const baseType = contractEvent.type().name;
    const topics = contractEvent.body().v0().topics();
    const firstTopic = topics[0];

    if (!firstTopic) return baseType;

    try {
      const decodedTopic = scValToNative(firstTopic);
      return typeof decodedTopic === 'string' ? `${baseType}:${decodedTopic}` : baseType;
    } catch {
      return baseType;
    }
  }

  // Issue #105 — refresh canary registration from the proxy's `get_canary`.
  async refreshCanary(): Promise<void> {
    try {
      if (!this.contractId) {
        this.canaryContractId = null;
        this.canaryShareBps = 0;
        canaryActive.set(0);
        canaryTrafficShareBps.set(0);
        return;
      }

      const dummyAccount = new Account(this.keypair.publicKey(), '0');
      const tx = new TransactionBuilder(dummyAccount, {
        fee: this.calculateInclusionFee(),
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'get_canary',
            args: [],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
      this.recordRpcCall('simulate');
      const simulateResponse: any = await this.server.simulateTransaction(tx);
      if (simulateResponse.error || !simulateResponse.result?.retval) {
        this.canaryContractId = null;
        this.canaryShareBps = 0;
      } else {
        const decoded: any = scValToNative(simulateResponse.result.retval);
        if (Array.isArray(decoded) && decoded.length >= 2) {
          this.canaryContractId = String(decoded[0]);
          this.canaryShareBps = Number(decoded[1]);
        } else {
          this.canaryContractId = null;
          this.canaryShareBps = 0;
        }
      }

      canaryActive.set(this.isCanaryActive() ? 1 : 0);
      canaryTrafficShareBps.set(this.canaryShareBps);
      canaryConsecutiveFailures.set(this.canaryRollbackGuard.consecutiveFailures());
      logger.debug('[Canary] refreshed registration', {
        canaryContractId: this.canaryContractId,
        shareBps: this.canaryShareBps,
      });
    } catch (err) {
      logger.warn('[Canary] failed to refresh registration', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  isCanaryActive(): boolean {
    return this.canaryContractId !== null && this.canaryShareBps > 0;
  }

  getCanaryState(): { contractId: string | null; shareBps: number } {
    return { contractId: this.canaryContractId, shareBps: this.canaryShareBps };
  }

  /** Zero the canary traffic share on-chain so no further traffic is routed. */
  private async rollbackCanary(): Promise<void> {
    logger.error('[Canary] rollback threshold reached — zeroing canary traffic share');
    canaryRollbacksTotal.inc();

    if (!config.canary.autoRollback || !this.canaryContractId) {
      logger.warn(
        '[Canary] auto-rollback disabled or no canary registered — run scripts/deploy-canary.js rollback manually',
      );
      return;
    }

    try {
      const account = await this.getAccount();
      const fee = this.calculateInclusionFee();
      const tx = new TransactionBuilder(account, {
        fee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'set_canary',
            args: [
              nativeToScVal(this.keypair.publicKey(), { type: 'address' }),
              nativeToScVal(this.canaryContractId, { type: 'address' }),
              nativeToScVal(0, { type: 'u32' }),
            ],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
      this.recordRpcCall('send');
      await this.server.sendTransaction(tx);

      this.canaryShareBps = 0;
      canaryTrafficShareBps.set(0);
      canaryActive.set(0);
      logger.error('[Canary] traffic share zeroed on-chain — canary paused');
    } catch (err) {
      logger.error('[Canary] auto-rollback transaction failed — manual rollback required', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async publishAggregated(prices: AggregatedPrice[]): Promise<void> {
    if (!this.publishingEnabled) {
      logger.debug('[Publisher] Skipping contract write: publication is suspended');
      return;
    }
    // Issue #742 — a fenced publisher must not start new writes; the
    // orchestrator drains and validates before unfencing.
    if (this.fenced) {
      logger.warn('[Publisher] Skipping publish round: publisher is fenced', {
        reason: this.fenceReason,
        assets: prices.length,
      });
      return;
    }
    this.resetRoundRpcMetrics();

    // Issue #741 — critical price publication is always allowed, but the
    // optional canary refresh is non-critical and is skipped under minimal
    // brownout to shed RPC load while preserving price freshness.
    if (this.brownout.isAllowed('canary_refresh')) {
      // Re-read the on-chain canary registration once per publish round
      await this.refreshCanary();
    } else {
      logger.debug('[Publisher] Brownout: skipping canary refresh (non-critical)');
    }

    // Issue #726 — refresh the consistent read snapshot for each asset before
    // publishing so evidence carries the policy version observed this round.
    // Falls back to the legacy read path when the snapshot interface is off
    // or unavailable (see SNAPSHOT_READS_ENABLED for rollout/rollback).
    for (const price of prices) {
      await this.readPriceSnapshot(price.asset);
    }

    // Issue #577 — attempt the Merkle batch path first.
    // One submit_batch transaction commits the root; N apply_batch_entry
    // transactions (one per asset, but far cheaper than full submit_price)
    // apply the individual prices.  Falls back to per-asset submit_price when
    // batch construction or the commit transaction fails.
    // Issue #741 — under minimal brownout the batch path is shed entirely and
    // the cheaper per-asset path is used to reduce transaction count.
    if (this.brownout.isAllowed('batch_publication')) {
      const batchSucceeded = await this.publishViaBatch(prices);
      if (batchSucceeded) {
        return;
      }
    } else {
      logger.warn('[Publisher] Brownout: batch path shed, using per-asset submission');
    }

    // Fallback: per-asset submit_price (original behaviour).
    logger.warn('[Publisher] Batch path failed or unavailable, falling back to per-asset submission');
    for (const price of prices) {
      // Issues #737, #738 — skip feeds owned by another region or mid-transfer.
      const authority = this.checkFeedAuthority(price.asset);
      if (!authority.allowed) {
        this.rejectUnauthorizedSubmission(price.asset, authority);
        continue;
      }

      this.submissionSequence += 1;
      const routeToCanary =
        this.isCanaryActive() &&
        shouldRouteToCanary(this.submissionSequence, this.canaryShareBps);

      if (routeToCanary) {
        const result = await this.submitPriceTo(
          this.canaryContractId as string,
          price.asset,
          BigInt(price.price),
          price.decimals,
          price.timestamp,
        );

        if (result) {
          this.canaryRollbackGuard.recordSuccess();
          canarySubmissionsTotal.inc({ status: 'success' });
        } else {
          const shouldRollback = this.canaryRollbackGuard.recordFailure();
          canarySubmissionsTotal.inc({ status: 'failed' });
          canaryConsecutiveFailures.set(this.canaryRollbackGuard.consecutiveFailures());
          if (shouldRollback) {
            await this.rollbackCanary();
          }
        }
      } else {
        await this.submitPrice(
          price.asset,
          BigInt(price.price),
          price.decimals,
          price.timestamp,
        );
      }
    }

    this.flushRoundRpcMetrics();
  }

  // Issue #577 — Merkle batch path implementation.
  //
  // Design:
  //   1. Read the current batch nonce from the contract (get_batch_nonce).
  //   2. Build a MerkleTree from all prices in this round.
  //   3. Call submit_batch(nonce, root, batch_size) — one authorized tx.
  //   4. For each entry, call apply_batch_entry with its proof.
  //      If apply fails for an entry (deviation, proof error, etc.) that
  //      entry is dropped for this round — a per-asset retry is NOT initiated
  //      here to avoid double-writing; the next poll round will re-submit it.
  //
  // Returns true if the batch commit succeeded (even if some applies failed).
  // Returns false when the commit fails so the caller falls back.
  //
  // Nonce: if the nonce read from the contract does not match the one we
  // expected (another region committed), the batch is abandoned and the
  // fallback path runs.
  //
  // Root expiry: RETAINED_BATCH_ROOTS = 16. Each round produces one batch.
  // Applies that have not been submitted within 16 rounds will be rejected
  // by the contract because the root has been pruned. The publisher
  // completes all applies in the same round, so this is not a concern in
  // practice, but the caller must be aware of it for partial-failure cases.
  private async publishViaBatch(prices: AggregatedPrice[]): Promise<boolean> {
    if (prices.length === 0) return true;

    // Issues #737, #738 — filter out feeds this region is not authorized to
    // publish. If nothing remains, the round is a no-op (return true so the
    // caller does not fall back to per-asset submission).
    const authorizedPrices = this.filterAuthorizedPrices(prices);
    if (authorizedPrices.length === 0) {
      logger.debug('[Publisher/Batch] No feeds authorized for this region in this round');
      return true;
    }
    prices = authorizedPrices;

    try {
      // Step 1: read current nonce.
      const nonce = await this.getBatchNonce();
      if (nonce === null) {
        logger.warn('[Publisher/Batch] Could not read batch nonce, skipping batch path');
        return false;
      }

      // Step 2: build Merkle tree.
      const entries: BatchPriceEntry[] = prices.map((p) => ({
        asset: p.asset,
        price: BigInt(p.price),
        decimals: p.decimals,
        timestamp: p.timestamp,
        source: this.keypair.publicKey(),
      }));

      const batch = MerkleTree.build(entries);

      // Step 3: submit_batch.
      const commitHash = await this.submitBatchRoot(
        nonce,
        batch.root,
        batch.batchSize,
      );
      if (!commitHash) {
        logger.warn('[Publisher/Batch] submit_batch transaction failed, falling back');
        return false;
      }

      contractSubmissionsTotal.inc({ path: 'batch', status: 'commit_success' });

      // Step 4: apply each entry.
      let applyFees = 0;
      let applyCount = 0;
      for (let i = 0; i < entries.length; i++) {
        const proof = batch.proofs[i];
        const fee = await this.applyBatchEntry(nonce, entries[i], proof);
        if (fee !== null) {
          applyFees += fee;
          applyCount += 1;
          contractSubmissionsTotal.inc({ path: 'batch', status: 'apply_success' });
        } else {
          contractSubmissionsTotal.inc({ path: 'batch', status: 'apply_failed' });
          logger.warn(`[Publisher/Batch] apply_batch_entry failed for ${entries[i].asset} at index ${i}`);
        }
      }

      // Record round cost metrics.
      contractBatchRoundTransactions.observe({ path: 'batch' }, 1 + entries.length);
      contractBatchRoundFeesTotal.inc({ path: 'batch' }, applyFees);
      logger.info(`[Publisher/Batch] Round complete: ${applyCount}/${entries.length} entries applied`, {
        nonce,
        batchSize: batch.batchSize,
        appliedCount: applyCount,
      });

      return true;
    } catch (err) {
      logger.error('[Publisher/Batch] Unexpected error in batch path', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Issues #737, #738 — return only the prices whose feeds this region is
   * currently authorized to publish, logging each rejected feed.
   */
  private filterAuthorizedPrices(prices: AggregatedPrice[]): AggregatedPrice[] {
    if (!this.ownershipRegistry) return prices;
    const authorized: AggregatedPrice[] = [];
    for (const price of prices) {
      const decision = this.checkFeedAuthority(price.asset);
      if (decision.allowed) {
        authorized.push(price);
      } else {
        this.rejectUnauthorizedSubmission(price.asset, decision);
      }
    }
    return authorized;
  }

  private async getBatchNonce(): Promise<bigint | null> {
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'get_batch_nonce',
            args: [],
          }),
        )
        .setTimeout(30)
        .build();
      tx.sign(this.keypair);
      const sim: SimulateResponse = await this.server.simulateTransaction(tx);
      if (sim.error || !sim.result?.retval) return null;
      return BigInt(scValToNative(sim.result.retval) as number | bigint);
    } catch (err) {
      logger.warn('[Publisher/Batch] getBatchNonce failed', { error: String(err) });
      return null;
    }
  }

  private async submitBatchRoot(
    nonce: bigint,
    root: Buffer,
    batchSize: number,
  ): Promise<string | null> {
    const startMs = Date.now();
    const fnName = 'submit_batch';
    let txHash = '';
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: fnName,
            args: [
              nativeToScVal(this.keypair.publicKey(), { type: 'address' }),
              nativeToScVal(nonce, { type: 'u64' }),
              nativeToScVal(root, { type: 'bytes' }),
              nativeToScVal(batchSize, { type: 'u32' }),
            ],
          }),
        )
        .setTimeout(30)
        .build();
      tx.sign(this.keypair);
      txHash = tx.hash().toString('hex');
      const sim: SimulateResponse = await this.server.simulateTransaction(tx);
      if (sim.error) {
        logger.warn(`[Publisher/Batch] submit_batch simulation failed`, { error: String(sim.error), txHash });
        return null;
      }
      const sendRes: SendResponse = await this.server.sendTransaction(tx);
      const fee = parseInt(String(sendRes?.fee ?? sim.minResourceFee ?? '0'), 10);
      if (!isNaN(fee)) {
        contractSubmissionGas.observe({ function: fnName, asset: 'batch', status: 'success' }, fee);
        contractSubmissionGasTotal.inc({ function: fnName, asset: 'batch', status: 'success' }, fee);
        contractBatchRoundFeesTotal.inc({ path: 'batch' }, fee);
      }
      logger.info(`[Publisher/Batch] submit_batch committed nonce=${nonce} batchSize=${batchSize}`, {
        txHash,
        durationMs: Date.now() - startMs,
      });
      return txHash;
    } catch (err) {
      logger.error(`[Publisher/Batch] submit_batch threw`, { error: String(err), txHash });
      return null;
    }
  }

  private async applyBatchEntry(
    nonce: bigint,
    entry: BatchPriceEntry,
    proof: { leafIndex: number; siblings: Buffer[] },
  ): Promise<number | null> {
    const fnName = 'apply_batch_entry';
    let txHash = '';
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());
      const entryScVal = nativeToScVal(
        {
          asset: entry.asset,
          price: entry.price,
          decimals: entry.decimals,
          timestamp: entry.timestamp,
          source: entry.source,
        },
        { type: 'map' },
      );
      const proofScVal = nativeToScVal(
        {
          leaf_index: proof.leafIndex,
          siblings: proof.siblings,
        },
        { type: 'map' },
      );
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: fnName,
            args: [
              nativeToScVal(nonce, { type: 'u64' }),
              entryScVal,
              proofScVal,
            ],
          }),
        )
        .setTimeout(30)
        .build();
      tx.sign(this.keypair);
      txHash = tx.hash().toString('hex');
      const sim: SimulateResponse = await this.server.simulateTransaction(tx);
      if (sim.error) {
        logger.warn(`[Publisher/Batch] apply_batch_entry simulation failed for ${entry.asset}`, {
          error: String(sim.error),
          txHash,
        });
        return null;
      }
      const sendRes: SendResponse = await this.server.sendTransaction(tx);
      const fee = parseInt(String(sendRes?.fee ?? sim.minResourceFee ?? '0'), 10);
      if (!isNaN(fee)) {
        contractSubmissionGas.observe({ function: fnName, asset: entry.asset, status: 'success' }, fee);
        contractSubmissionGasTotal.inc({ function: fnName, asset: entry.asset, status: 'success' }, fee);
      }
      return isNaN(fee) ? 0 : fee;
    } catch (err) {
      logger.warn(`[Publisher/Batch] apply_batch_entry threw for ${entry.asset}`, {
        error: String(err),
        txHash,
      });
      return null;
    }
  }

  processRetryQueue(): void {
    if (!this.publishingEnabled) return;
    // Issue #742 — never flush the retry queue while fenced.
    if (this.fenced) {
      logger.debug('[Publisher] Skipping retry processing: publisher is fenced', {
        reason: this.fenceReason,
      });
      return;
    }
    // Issue #741 — retry processing is non-critical work; under minimal
    // brownout it is deferred so RPC capacity is reserved for fresh prices.
    if (!this.brownout.isAllowed('retry_processing')) {
      logger.debug('[Publisher] Brownout: deferring retry queue processing');
      return;
    }
    const items = this.retryQueue.getQueueItems();
    for (const item of items) {
      this.submitPrice(item.asset, item.price, item.decimals, item.timestamp, item.epoch)
        .then((result) => {
          if (result) {
            this.retryQueue.remove(`${item.asset}:${item.timestamp}`);
          }
        })
        .catch((err) => {
          logger.error(`[Publisher] Error processing retry for ${item.asset}:`, err);
        });
    }
  }

  getRetryQueueMetrics() {
    return this.retryQueue.getMetrics();
  }

  getRetryQueueSize(): number {
    return this.retryQueue.getQueueSize();
  }

  getSubmissionSequence(): number {
    return this.submissionSequence;
  }

  /** Issue #745 — persisted fencing state, for health checks and dashboards. */
  getFencingEpochState(): FencingEpochState {
    return this.fencingEpochStore.load();
  }

  getConsecutiveFailures(): number {
    return this.canaryRollbackGuard.consecutiveFailures();
  }

  /** Drain pending items and clean up resources on shutdown (Issue #574) */
  async shutdown(): Promise<void> {
    logger.info('[Publisher] Shutting down publisher and draining retry queue...');
    this.retryQueue.stop();
    await this.drainRetryQueue();
  }

  async drainRetryQueue(): Promise<void> {
    const items = this.retryQueue.getQueueItems();
    if (items.length > 0) {
      logger.info(`[Publisher] Draining ${items.length} item(s) from retry queue before exit...`);
      for (const item of items) {
        if (!this.publishingEnabled) break;
        // Issue #742 — stop draining as soon as the publisher is fenced so a
        // maintenance drain cannot race with a fresh fence.
        if (this.fenced) {
          logger.warn('[Publisher] Drain aborted: publisher was fenced mid-drain', {
            reason: this.fenceReason,
            remaining: items.length,
          });
          break;
        }
        try {
          const result = await this.submitPrice(
            item.asset,
            item.price,
            item.decimals,
            item.timestamp,
            item.epoch,
          );
          if (result) {
            this.retryQueue.remove(`${item.asset}:${item.timestamp}`);
          }
        } catch (err) {
          logger.warn(`[Publisher] Could not drain retry item for ${item.asset}:`, err);
        }
      }
    }
  }

  dispose(): void {
    this.retryQueue.stop();
  }
}
