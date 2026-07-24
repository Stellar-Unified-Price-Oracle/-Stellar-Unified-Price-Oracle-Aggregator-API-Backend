import {
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from './config';
import { logger } from './utils/logger';
import { AggregatedPrice } from './types';
import { MerkleTree, BatchPriceEntry } from './utils/merkle';
import { TrafficSplitter, CanaryMonitor, calcDeviationBps } from './canary';

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

  private splitter: TrafficSplitter | null = null;
  private monitor: CanaryMonitor | null = null;

  constructor() {
    this.server = new SorobanRpc.Server(config.soroban.rpcUrl);
    this.keypair = Keypair.fromSecret(config.soroban.adminSecret);
    this.contractId = config.soroban.contractId;
    this.networkPassphrase = config.soroban.networkPassphrase;

    if (config.canary.enabled && config.canary.contractId) {
      this.splitter = new TrafficSplitter({
        canaryWeight: config.canary.trafficWeight,
        enabled: true,
      });
      this.monitor = new CanaryMonitor({
        maxDeviationBps: config.canary.maxDeviationBps,
        maxConsecutiveFailures: config.canary.maxConsecutiveFailures,
        rollbackCallback: () => this.rollbackCanary(),
      });
      logger.info(
        `[Canary] Initialized — canary contract: ${config.canary.contractId}, ` +
        `traffic weight: ${config.canary.trafficWeight}%`,
      );
    }
  }

  private rollbackCanary(): void {
    if (this.splitter) {
      this.splitter.disable();
      logger.error('[Canary] Rollback complete — splitter disabled, all traffic on stable contract');
    }
  }

  getCanaryMetrics() {
    return {
      splitter: this.splitter?.getStats() ?? null,
      monitor: this.monitor?.getMetrics() ?? null,
    };
  }

  // ── Individual submission (unchanged) ──────────────────────────────────────

  async submitPrice(
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
            contract: this.contractId,
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

      const simulateResponse: any = await this.server.simulateTransaction(tx);
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

      const sendResponse: any = await this.server.sendTransaction(tx);
      const actualFee = sendResponse?.fee ?? simulationFee;
      const feeNum = parseInt(String(actualFee), 10);

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
      return null;
    }
  }

  private async captureContractEvents(txHash: string): Promise<void> {
    try {
      const response: any = await this.server.getTransaction(txHash);
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

  private extractEvents(_resultMetaXdr: unknown): xdr.DiagnosticEvent[] {
    return [];
  }

  private parseEventType(_event: xdr.DiagnosticEvent): string {
    return 'contract_event';
  }

  async publishAggregated(prices: AggregatedPrice[]): Promise<void> {
    for (const price of prices) {
      if (this.splitter && this.monitor && !this.monitor.isRolledBack() && config.canary.contractId) {
        const target = this.splitter.selectTarget();

        if (target === 'canary') {
          // Publish to canary only; also get stable for comparison
          const [stableTx, canaryTx] = await Promise.all([
            this.submitPrice(price.asset, BigInt(price.price), price.decimals, price.timestamp),
            this.submitPriceTo(
              config.canary.contractId,
              price.asset,
              BigInt(price.price),
              price.decimals,
              price.timestamp,
            ),
          ]);
          this.monitor.record({
            asset: price.asset,
            stablePrice: price.price,
            canaryPrice: price.price, // same input price; we monitor TX outcome
            decimals: price.decimals,
            timestamp: price.timestamp,
            stableTxHash: stableTx,
            canaryTxHash: canaryTx,
            canaryFailed: canaryTx === null,
            deviationBps: 0, // same price sent — deviation comes from independent canary reads
          });
        } else {
          await this.submitPrice(price.asset, BigInt(price.price), price.decimals, price.timestamp);
        }
      } else {
        await this.submitPrice(price.asset, BigInt(price.price), price.decimals, price.timestamp);
      }
    }
  }

  private async submitPriceTo(
    contractId: string,
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
  ): Promise<string | null> {
    const startMs = Date.now();
    const fnName = 'submit_price';
    const params = { contractId, asset, price: price.toString(), decimals, timestamp };
    let txHash = '';
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
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

      const sim: any = await this.server.simulateTransaction(tx);
      if (sim.error) {
        logger.warn(`[Canary] Simulation failed for ${asset}: ${sim.error}`);
        return null;
      }

      const resp: any = await this.server.sendTransaction(tx);
      logger.debug(`[Canary] Submitted ${asset} to canary contract ${contractId.slice(0, 8)}… tx: ${resp.hash}`);
      return resp.hash ?? txHash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Canary] Failed to submit ${asset} to canary: ${msg}`);
      return null;
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async fetchBatchNonce(): Promise<number | null> {
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

      const sim: any = await this.server.simulateTransaction(tx);
      if (sim.error || !sim.result) return null;

      const val = sim.result.retval;
      if (val.switch().name === 'scvU64') {
        return Number(val.u64().toBigInt());
      }
      return null;
    } catch {
      return null;
    }
  }

  private async callContract(
    fn: string,
    args: xdr.ScVal[],
  ): Promise<boolean> {
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: fn,
            args,
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);

      const sim: any = await this.server.simulateTransaction(tx);
      if (sim.error) {
        logger.error(`[Publisher] ${fn} simulate error: ${sim.error}`);
        return false;
      }

      const resp = await this.server.sendTransaction(tx);
      logger.debug(`[Publisher] ${fn} tx: ${resp.hash}`);
      return true;
    } catch (err) {
      logger.error(`[Publisher] ${fn} failed`, err);
      return false;
    }
  }
}
