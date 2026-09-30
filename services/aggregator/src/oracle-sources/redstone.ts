import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

export class RedstoneSource extends BaseSource {
  name: OracleSourceName = 'redstone';

  private readonly baseUrl: string;
  protected readonly schema: ProviderSchemaName = 'redstone';

  constructor() {
    super();
    this.baseUrl = config.sources.redstone.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = asset.toUpperCase();
    const response = await httpClient.get<unknown>(`${this.baseUrl}/prices`, {
      params: { symbols: symbol, provider: 'redstone' },
    });

    const result = parseProviderResponse(this.schema, response.data, symbol);
    if (result.kind === 'no-price') return null;
    if (result.kind === 'invalid-payload') {
      reportInvalidPayload(this.name, symbol, result, response.data);
      this.recordInvalidPayload(symbol, result.issues);
      return null;
    }

    // The response carries no observation time, so the age of this price
    // cannot be established from the provider (`null`, not `Date.now()`).
    return this.normalizeValidated(symbol, result);
  }
}
