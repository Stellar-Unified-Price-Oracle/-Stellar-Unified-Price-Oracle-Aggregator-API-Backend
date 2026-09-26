import {
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
} from '../observability/metrics';
import { AggregatedPrice } from '../infrastructure/types';
import {
  contractSubmissionGas,
  contractSubmissionGasTotal,
  contractSubmissionOutcome,
  contractOutcomeFailureRatio,
  contractOutcomeTotalWindow,
  contractOutcomeFailedWindow,
} from '../observability/metrics';
import { CanaryRollbackGuard, shouldRouteToCanary } from './canary';
import { SubmissionRetryQueue } from './retry-queue';

interface ContractCallLog {
  txHash: string;
  function: string;
  asset: string;
  params: Record<string, unknown>;
  simulationFee?: string;
  actualFee?: string;
  status: 'success' | 'failed' | 'simulation_failed';
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
 *
 * A superset of the SDK's simplified success/error shapes: the publisher
 * reads `minResourceFee`/`cost.feeCharged` (only present on success) and
 * `error` (only present on failure), so the local type keeps every branch
 * assignable and marks the divergent fields optional.
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
 * error name (e.g. "UnauthorizedSource") if present.  Returns null when the
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

export class ContractPublisher {
  private server: SorobanRpc.Server;
  private keypair: Keypair;
  private contractId: string;
  private networkPassphrase: string;
  private retryQueue: SubmissionRetryQueue;

  // Issue #105 — canary deployment state, refreshed from the on-chain
  // `get_canary` registration on the proxy contract id.
  private canaryContractId: string | null = null;
  private canaryShareBps = 0;
  private submissionSequence = 0;
  private canaryRollbackGuard: CanaryRollbackGuard;

  constructor() {
    this.server = new SorobanRpc.Server(config.soroban.rpcUrl);
    this.keypair = Keypair.fromSecret(config.soroban.adminSecret);
    this.contractId = config.soroban.contractId;
    this.networkPassphrase = config.soroban.networkPassphrase;
    this.canaryRollbackGuard = new CanaryRollbackGuard(config.canary.failureThreshold);

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

  // ── Individual submission ──────────────────────────────────────────────────

  async submitPrice(
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
  ): Promise<string | null> {
    // Retries and direct submissions always target the canonical contract;
    // only publishAggregated() routes a share of the live stream to a canary.
    return this.submitPriceTo(this.contractId, asset, price, decimals, timestamp);
  }

  /** Send one submission to a specific contract id (canonical or canary). */
  private async submitPriceTo(
    targetContractId: string,
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
  ): Promise<string | null> {
    const startMs = Date.now();
    const fnName = 'submit_price';
    const params = { asset, price: price.toString(), decimals, timestamp };

    let txHash = '';
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: '100',
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
            ],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
      txHash = tx.hash().toString('hex');

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
        emitContractLog({
          txHash,
          function: fnName,
          asset,
          params,
          simulationFee: String(simulationFee),
          status: 'simulation_failed',
          error: String(simulateResponse.error),
          durationMs: Date.now() - startMs,
          timestamp: Math.floor(Date.now() / 1000),
        });
        return null;
      }

      // Issue #576 — sendTransaction only means the network accepted the
      // envelope into its queue.  We must poll getTransaction for the
      // terminal on-chain status before recording any outcome.
      const sendResponse: SendResponse = await this.server.sendTransaction(tx);
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
        this.retryQueue.enqueue({ asset, price, decimals, timestamp });
      }

      return null;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emitContractLog({
        txHash: txHash || 'unknown',
        function: fnName,
        asset,
        params,
        status: 'failed',
        error: errMsg,
        durationMs: Date.now() - startMs,
        timestamp: Math.floor(Date.now() / 1000),
      });
      logger.error(`[Contract] Failed to submit ${asset}: ${errMsg}`, { txHash });

      contractSubmissionOutcome.inc({ function: fnName, asset, outcome: 'failed' });
      recordOutcome(fnName, 'failed');

      this.retryQueue.enqueue({
        asset,
        price,
        decimals,
        timestamp,
      });

      return null;
    }
  }

  // Issue #382 — on-chain price staleness heartbeat.
  //
  // Read-only `get_price` simulation: no signing/sending needed, but the SDK
  // still requires a built+signed transaction envelope to simulate against.
  // Returns the on-chain `timestamp` field (seconds) for `asset`, or null if
  // the asset has never been submitted or the call fails.
  async getOnChainTimestamp(asset: string): Promise<number | null> {
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100',
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
      if (!txResponse || txResponse.status === 'NOT_FOUND') return;

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
  // The proxy contract (this.contractId) is the source of truth for whether a
  // canary is deployed and what share of traffic it should receive.
  async refreshCanary(): Promise<void> {
    try {
      if (!this.contractId) {
        this.canaryContractId = null;
        this.canaryShareBps = 0;
        canaryActive.set(0);
        canaryTrafficShareBps.set(0);
        return;
      }

      const account = await this.server.getAccount(this.keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100',
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
      const simulateResponse: any = await this.server.simulateTransaction(tx);
      if (simulateResponse.error || !simulateResponse.result?.retval) {
        // No canary registered (or call failed) — treat as inactive.
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
      const account = await this.server.getAccount(this.keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100',
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
    // Re-read the on-chain canary registration once per publish round so a
    // promote/rollback by an operator is picked up promptly.
    await this.refreshCanary();

    for (const price of prices) {
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
  }

  processRetryQueue(): void {
    const items = this.retryQueue.getQueueItems();
    for (const item of items) {
      this.submitPrice(item.asset, item.price, item.decimals, item.timestamp)
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
}
