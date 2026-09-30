import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

export class BandSource extends BaseSource {
  name: OracleSourceName = 'band';

  private readonly baseUrl: string;
  protected readonly schema: ProviderSchemaName = 'band';

  constructor() {
    super();
    this.baseUrl = config.sources.band.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = this.toSymbol(asset);
    const response = await httpClient.get<unknown>(
      `${this.baseUrl}/oracle/v1/feeds/${symbol}`,
    );

    const result = parseProviderResponse(this.schema, response.data, asset);
    if (result.kind === 'no-price') return null;
    if (result.kind === 'invalid-payload') {
      reportInvalidPayload(this.name, asset, result, response.data);
      this.recordInvalidPayload(asset, result.issues);
      return null;
    }

    // Band reports the provider's own update time; keep it as `observedAt`
    // rather than falling back to local fetch time when it is missing.
    return this.normalizeValidated(asset, result);
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
