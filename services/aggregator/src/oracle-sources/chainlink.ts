import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';

export class ChainlinkSource extends BaseSource {
  name: OracleSourceName = 'chainlink';

  private readonly baseUrl: string;

  constructor() {
    super();
    this.baseUrl = config.sources.chainlink.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = this.toSymbol(asset);
    const response = await httpClient.get(`${this.baseUrl}/price`, {
      params: { fsym: symbol, tsym: 'USD', api_key: config.sources.chainlink.apiKey },
    });

    if (!response.data?.USD?.PRICE) return null;

    return this.normalize(
      asset,
      response.data.USD.PRICE,
      8,
      Math.floor(Date.now() / 1000),
    );
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
