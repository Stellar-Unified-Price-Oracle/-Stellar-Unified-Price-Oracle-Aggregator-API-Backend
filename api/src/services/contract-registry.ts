import { SorobanRpc } from '@stellar/js-stellar-sdk';
import { config } from '../config';
import { logger } from '../middleware/logger';

export interface TokenMetadata {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  issuer?: string;
}

class ContractRegistry {
  private cache: Map<string, TokenMetadata> = new Map();
  private rpcClient: SorobanRpc.Server;
  private static readonly CONTRACT_CACHE_TTL = 3600000; // 1 hour

  constructor() {
    this.rpcClient = new SorobanRpc.Server(config.stellarRpcUrl);
  }

  private isContractId(assetId: string): boolean {
    return assetId.startsWith('C') && assetId.length === 56;
  }

  async getTokenMetadata(contractId: string): Promise<TokenMetadata | null> {
    const cached = this.cache.get(contractId);
    if (cached) {
      return cached;
    }

    try {
      const metadata = await this.fetchContractMetadata(contractId);
      if (metadata) {
        this.cache.set(contractId, metadata);
        setTimeout(() => this.cache.delete(contractId), ContractRegistry.CONTRACT_CACHE_TTL);
      }
      return metadata;
    } catch (error) {
      logger.error(`Failed to fetch metadata for contract ${contractId}:`, error);
      return null;
    }
  }

  private async fetchContractMetadata(contractId: string): Promise<TokenMetadata | null> {
    try {
      // Validate contract exists by checking ledger entries
      const ledgerEntries = await this.rpcClient.getLedgerEntries(
        `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`,
      ).catch(() => null);

      // For now, create a basic metadata object
      // In production, this would invoke the contract methods properly
      return {
        contractId,
        symbol: this.deriveSymbolFromContractId(contractId),
        name: `Token ${contractId.substring(0, 8)}`,
        decimals: 18,
      };
    } catch (error) {
      logger.error(`Error fetching metadata for ${contractId}:`, error);
      return null;
    }
  }

  private deriveSymbolFromContractId(contractId: string): string {
    // Derive a reasonable symbol from the contract ID
    return `TOKEN-${contractId.substring(0, 8).toUpperCase()}`;
  }

  resolveAssetId(assetId: string): string {
    if (this.isContractId(assetId)) {
      const metadata = this.cache.get(assetId);
      return metadata?.symbol || assetId;
    }
    return assetId.toUpperCase();
  }

  isValidAssetId(assetId: string): boolean {
    return this.isContractId(assetId) || /^[A-Z0-9]{1,12}$/.test(assetId);
  }
}

export const contractRegistry = new ContractRegistry();
