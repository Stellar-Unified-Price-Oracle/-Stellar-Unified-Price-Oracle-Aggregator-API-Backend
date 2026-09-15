import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';

interface ChainlinkPriceResponse {
  USD?: {
    PRICE: string | number;
  };
}

export class ChainlinkSource extends BaseSource {
  name: OracleSourceName = 'chainlink';

  private readonly baseUrl: string;

  constructor() {
    super();
    this.baseUrl = config.sources.chainlink.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = this.toSymbol(asset);
    const response = await httpClient.get<ChainlinkPriceResponse>(`${this.baseUrl}/price`, {
      params: { fsym: symbol, tsym: 'USD', api_key: config.sources.chainlink.apiKey },
    });

    if (!response.data?.USD?.PRICE) return null;

    // This endpoint returns a price but no observation time, so the provider's
    // own timestamp is unavailable. Passing `null` rather than `Date.now()`
    // keeps that gap visible: the resulting price is never counted as
    // age-verified, instead of looking permanently fresh.
    return this.normalize(asset, response.data.USD.PRICE, 8, null);
  }

  private toSymbol(asset: string): string {
    const map: Record<string, string> = {
      XLM: 'XLM',
      USDC: 'USDC',
      BTC: 'BTC',
      ETH: 'ETH',
      USDT: 'USDT',
    };
    return map[asset.toUpperCase()] || asset;
  }
}
