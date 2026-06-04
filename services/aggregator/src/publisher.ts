import { Keypair, SorobanRpc, TransactionBuilder, Operation, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { config } from './config';
import { logger } from './utils/logger';
import { AggregatedPrice } from './types';

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

      const sendResponse = await this.server.sendTransaction(tx);
      logger.info(`[Publisher] Submitted ${asset}: ${price} (tx: ${txHash})`);

      return txHash;
    } catch (err) {
      logger.error(`[Publisher] Failed to submit ${asset}`, err);
      return null;
    }
  }

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
}
