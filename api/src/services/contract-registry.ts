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
  private static readonly CONTRACT_CACHE_TTL = 3600000; // 1 hour

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
      // In a production implementation, this would:
      // 1. Connect to Soroban RPC at config.stellarRpcUrl
      // 2. Invoke contract read-only methods (symbol, decimals, name)
      // 3. Return parsed metadata
      //
      // For now, create a basic metadata object with derived values
      // This allows the API to respond with contract metadata even before full implementation

      return {
        contractId,
        symbol: this.deriveSymbolFromContractId(contractId),
        name: `Soroban Token ${contractId.substring(0, 8)}`,
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
