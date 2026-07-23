import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';

export class RedstoneSource extends BaseSource {
  name: OracleSourceName = 'redstone';

  private readonly baseUrl: string;

  constructor() {
    super();
    this.baseUrl = config.sources.redstone.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = asset.toUpperCase();
    const response = await httpClient.get(`${this.baseUrl}/prices`, {
      params: { symbols: symbol, provider: 'redstone' },
    });

    const data = response.data?.[symbol];
    if (!data?.value) return null;

    return this.normalize(
      asset,
      data.value,
      data.decimals || 8,
      Math.floor(Date.now() / 1000),
    );
  }
}
