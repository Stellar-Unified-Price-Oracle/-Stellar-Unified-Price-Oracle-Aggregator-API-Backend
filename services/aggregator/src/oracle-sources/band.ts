import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';

interface BandFeedData {
  price: string;
  decimals?: number;
  updated_at?: number;
}

export class BandSource extends BaseSource {
  name: OracleSourceName = 'band';

  private readonly baseUrl: string;

  constructor() {
    super();
    this.baseUrl = config.sources.band.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = this.toSymbol(asset);
    const response = await httpClient.get<{ data?: BandFeedData }>(
      `${this.baseUrl}/oracle/v1/feeds/${symbol}`,
    );

    if (!response.data?.data?.price) return null;

    // Band reports the provider's own update time; keep it as `observedAt`
    // rather than falling back to local fetch time when it is missing.
    return this.normalize(
      asset,
      response.data.data.price,
      response.data.data.decimals || 9,
      response.data.data.updated_at ?? null,
    );
  }

  private toSymbol(asset: string): string {
    const map: Record<string, string> = {
      XLM: 'XLM',
      USDC: 'USDC-USD',
      BTC: 'BTC-USD',
      ETH: 'ETH-USD',
      USDT: 'USDT-USD',
    };
    return map[asset.toUpperCase()] || `${asset}-USD`;
  }
}
