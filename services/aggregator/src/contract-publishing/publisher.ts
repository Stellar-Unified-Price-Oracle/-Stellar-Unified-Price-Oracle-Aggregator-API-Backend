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
  contractSubmissionsTotal,
  contractBatchRoundFeesTotal,
  contractBatchRoundTransactions,
} from '../observability/metrics';
import { AggregatedPrice } from '../infrastructure/types';
import { contractSubmissionGas, contractSubmissionGasTotal } from '../observability/metrics';
import { CanaryRollbackGuard, shouldRouteToCanary } from './canary';
import { SubmissionRetryQueue } from './retry-queue';
import { MerkleTree, BatchPriceEntry } from '../infrastructure/merkle';

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

const GAS_ALERT_THRESHOLD = parseInt(process.env.CONTRACT_GAS_ALERT_THRESHOLD || '50000', 10);

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

  // ── Individual submission (unchanged) ──────────────────────────────────────

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

      const sendResponse: SendResponse = await this.server.sendTransaction(tx);
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
            args: [nativeToScVal(asset, { type: 'string' })],
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);
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
    // Re-read the on-chain canary registration once per publish round.
    await this.refreshCanary();

    // Issue #577 — attempt the Merkle batch path first.
    // One submit_batch transaction commits the root; N apply_batch_entry
    // transactions (one per asset, but far cheaper than full submit_price)
    // apply the individual prices.  Falls back to per-asset submit_price when
    // batch construction or the commit transaction fails.
    const batchSucceeded = await this.publishViaBatch(prices);
    if (batchSucceeded) {
      return;
    }

    // Fallback: per-asset submit_price (original behaviour).
    logger.warn('[Publisher] Batch path failed or unavailable, falling back to per-asset submission');
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

    contractBatchRoundTransactions.observe({ path: 'per_asset' }, prices.length);
    contractSubmissionsTotal.inc({ path: 'per_asset', status: 'success' }, prices.length);
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
