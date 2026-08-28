import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';

export class ReflectorSource extends BaseSource {
  name: OracleSourceName = 'reflector';

  private readonly baseUrl: string;

  constructor() {
    super();
    this.baseUrl = config.sources.reflector.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = `Crypto.${asset}/USD`;
    const response = await httpClient.get(`${this.baseUrl}/v1/prices`, {
      params: { asset: symbol },
    });

    const data = response.data?.prices?.[symbol];
    if (!data?.price) return null;

    return this.normalize(
      asset,
      data.price,
      data.decimals || 8,
      data.timestamp || Math.floor(Date.now() / 1000),
    );
  }
}
