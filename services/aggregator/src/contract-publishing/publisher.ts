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
} from '../observability/metrics';
import { AggregatedPrice } from '../infrastructure/types';
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

const GAS_ALERT_THRESHOLD = parseInt(process.env.CONTRACT_GAS_ALERT_THRESHOLD || '50000', 10);

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

  constructor(feePolicy: Partial<FeePolicy> = {}) {
    this.server = new SorobanRpc.Server(config.soroban.rpcUrl);
    this.keypair = Keypair.fromSecret(config.soroban.adminSecret);
    this.contractId = config.soroban.contractId;
    this.networkPassphrase = config.soroban.networkPassphrase;
    this.feePolicy = { ...DEFAULT_FEE_POLICY, ...feePolicy };
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
  ): Promise<string | null> {
    return this.submitPriceTo(this.contractId, asset, price, decimals, timestamp);
  }

  /** Send one submission to a specific contract id with bad-sequence recovery */
  private async submitPriceTo(
    targetContractId: string,
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
    isRetry = false,
  ): Promise<string | null> {
    const startMs = Date.now();
    const fnName = 'submit_price';
    const params = { asset, price: price.toString(), decimals, timestamp };

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
            ],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
      txHash = tx.hash().toString('hex');

      this.recordRpcCall('simulate');
      const simulateResponse: SimulateResponse = await this.server.simulateTransaction(tx);
      const simulationFee = simulateResponse?.minResourceFee ?? simulateResponse?.cost?.feeCharged ?? 'unknown';

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
          return this.submitPriceTo(targetContractId, asset, price, decimals, timestamp, true);
        }
      }

      const actualFee = sendResponse?.fee ?? simulationFee;
      const feeNum = parseInt(String(actualFee), 10);

      if (!Number.isNaN(feeNum)) {
        contractSubmissionGas.observe({ function: fnName, asset, status: 'success' }, feeNum);
        contractSubmissionGasTotal.inc({ function: fnName, asset, status: 'success' }, feeNum);
      }

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

      if (!isNaN(feeNum) && feeNum > GAS_ALERT_THRESHOLD) {
        checkGasAlert({ txHash, function: fnName, fee: feeNum, threshold: GAS_ALERT_THRESHOLD });
      }

      await this.captureContractEvents(txHash);

      return txHash;
    } catch (err) {
      if (!isRetry && isBadSeqError(err)) {
        logger.warn(`[Contract] tx_bad_seq exception for ${asset}. Resyncing sequence and retrying once...`);
        try {
          await this.getAccount(true);
          return this.submitPriceTo(targetContractId, asset, price, decimals, timestamp, true);
        } catch (resyncErr) {
          logger.error(`[Contract] Failed to resync account after tx_bad_seq: ${resyncErr}`);
        }
      }

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

      this.retryQueue.enqueue({
        asset,
        price,
        decimals,
        timestamp,
      });

      return null;
    }
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
            args: [nativeToScVal(asset, { type: 'string' })],
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

      const decoded = scValToNative(simulateResponse.result.retval) as { timestamp?: unknown } | undefined;
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

  private async captureContractEvents(txHash: string): Promise<void> {
    try {
      this.recordRpcCall('get_transaction');
      const response: GetTransactionResponse = await this.server.getTransaction(txHash);
      if (!response || response.status === 'NOT_FOUND') return;

      const events: xdr.DiagnosticEvent[] = response?.resultMetaXdr
        ? this.extractEvents(response.resultMetaXdr)
        : [];

      for (const event of events) {
        const eventType = this.parseEventType(event);
        logger.info(`[Contract] Event captured: ${eventType}`, { txHash, eventType });
      }

      if (events.length > 0) {
        logger.info(`[Contract] Captured ${events.length} event(s) from tx ${txHash}`);
      }
    } catch (err) {
      logger.debug(`[Contract] Could not capture events for ${txHash}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private extractEvents(resultMetaXdr: unknown): xdr.DiagnosticEvent[] {
    if (Array.isArray(resultMetaXdr)) {
      return resultMetaXdr.filter((event): event is xdr.DiagnosticEvent => xdr.DiagnosticEvent.isValid(event));
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
    this.resetRoundRpcMetrics();

    // Re-read the on-chain canary registration once per publish round
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

    this.flushRoundRpcMetrics();
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

  getSubmissionSequence(): number {
    return this.submissionSequence;
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
        try {
          const result = await this.submitPrice(item.asset, item.price, item.decimals, item.timestamp);
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
