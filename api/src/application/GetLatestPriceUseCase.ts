import type { IPriceRepository } from '../domain/ports/IPriceRepository';
import { Price } from '../domain/entities/Price';
import type { AssetPair } from '../types/branded';

export interface GetLatestPriceResult {
  found: true;
  price: Price;
} | {
  found: false;
};

/**
 * GetLatestPriceUseCase
 *
 * Returns the most recent price record for the requested asset pair.
 * The implementation is intentionally thin — validation and persistence
 * belong to dedicated use-cases or domain services.
 */
export class GetLatestPriceUseCase {
  constructor(private readonly priceRepository: IPriceRepository) {}

  async execute(pair: AssetPair): Promise<{ found: boolean; price?: Price }> {
    const record = await this.priceRepository.findLatest(pair);
    if (!record) return { found: false };
    return { found: true, price: Price.fromRecord(record) };
  }
}
