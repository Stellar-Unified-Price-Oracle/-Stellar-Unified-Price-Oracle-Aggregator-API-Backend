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

export class ContractPublisher {
  private server: SorobanRpc.Server;
  private keypair: Keypair;
  private contractId: string;
  private networkPassphrase: string;

  constructor() {
    this.server = new SorobanRpc.Server(config.soroban.rpcUrl);
    this.keypair = Keypair.fromSecret(config.soroban.adminSecret);
    this.contractId = config.soroban.contractId;
    this.networkPassphrase = config.soroban.networkPassphrase;
  }

  // ── Individual submission (unchanged) ──────────────────────────────────────

  async submitPrice(
    asset: string,
    price: bigint,
    decimals: number,
    timestamp: number,
  ): Promise<string | null> {
    try {
      const account = await this.server.getAccount(this.keypair.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'submit_price',
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
      const txHash = tx.hash().toString('hex');

      const simulateResponse: any = await this.server.simulateTransaction(tx);
      if (simulateResponse.error) {
        logger.error(`[Publisher] Simulate error: ${simulateResponse.error}`);
        return null;
      }

      await this.server.sendTransaction(tx);
      logger.info(`[Publisher] Submitted ${asset}: ${price} (tx: ${txHash})`);
      return txHash;
    } catch (err) {
      logger.error(`[Publisher] Failed to submit ${asset}`, err);
      return null;
    }
  }

  // ── Merkle batch submission ─────────────────────────────────────────────────

  /**
   * Submit a batch of prices as a single Merkle root commitment, then apply
   * each entry with its inclusion proof.
   *
   * Protocol:
   *   1. Build off-chain Merkle tree from all entries.
   *   2. Fetch current batch nonce from the contract.
   *   3. Call submit_batch(source, nonce, root) — one transaction for N prices.
   *   4. Call apply_batch_entry(nonce, entry, proof) for each entry.
   *
   * Gas saving: steps 3 + 4×N replaces N individual submit_price calls that
   * each carry full auth + source-check overhead.  The saving grows with N.
   */
  async batchSubmit(prices: AggregatedPrice[]): Promise<void> {
    if (prices.length === 0) return;

    const entries: BatchPriceEntry[] = prices.map((p) => ({
      asset: p.asset,
      price: BigInt(p.price),
      decimals: p.decimals,
      timestamp: p.timestamp,
      source: this.keypair.publicKey(),
    }));

    const batch = MerkleTree.build(entries);
    logger.info(
      `[Publisher] Building Merkle batch: ${entries.length} entries, root=${batch.root.toString('hex')}`,
    );

    // Fetch current nonce
    const nonce = await this.fetchBatchNonce();
    if (nonce === null) {
      logger.warn('[Publisher] Could not fetch batch nonce, falling back to individual submissions');
      await this.publishAggregated(prices);
      return;
    }

    // Step 1: commit the Merkle root
    const rootCommitted = await this.callContract('submit_batch', [
      nativeToScVal(this.keypair.publicKey(), { type: 'address' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
      xdr.ScVal.scvBytes(batch.root),
    ]);

    if (!rootCommitted) {
      logger.warn('[Publisher] submit_batch failed, falling back to individual submissions');
      await this.publishAggregated(prices);
      return;
    }

    logger.info(`[Publisher] Batch root committed (nonce=${nonce})`);

    // Step 2: apply each entry with its proof
    let applied = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const proof = batch.proofs[i];

      const siblings = proof.siblings.map((s) => xdr.ScVal.scvBytes(s));
      const proofScVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('leaf_index'),
          val: nativeToScVal(proof.leafIndex, { type: 'u32' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('siblings'),
          val: xdr.ScVal.scvVec(siblings),
        }),
      ]);

      const entryScVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('asset'),
          val: nativeToScVal(entry.asset, { type: 'string' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('decimals'),
          val: nativeToScVal(entry.decimals, { type: 'u32' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('price'),
          val: nativeToScVal(entry.price, { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('source'),
          val: nativeToScVal(entry.source, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('timestamp'),
          val: nativeToScVal(BigInt(entry.timestamp), { type: 'u64' }),
        }),
      ]);

      const ok = await this.callContract('apply_batch_entry', [
        nativeToScVal(BigInt(nonce), { type: 'u64' }),
        entryScVal,
        proofScVal,
      ]);

      if (ok) {
        applied++;
        logger.info(`[Publisher] Applied batch entry ${i + 1}/${entries.length}: ${entry.asset}`);
      } else {
        logger.warn(`[Publisher] Failed to apply batch entry ${i}: ${entry.asset}`);
      }
    }

    logger.info(`[Publisher] Batch complete: ${applied}/${entries.length} entries applied`);
  }

  // ── Original individual-submission loop ────────────────────────────────────

  async publishAggregated(prices: AggregatedPrice[]): Promise<void> {
    for (const price of prices) {
      await this.submitPrice(
        price.asset,
        BigInt(price.price),
        price.decimals,
        price.timestamp,
      );
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
