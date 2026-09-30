import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

export class ChainlinkSource extends BaseSource {
  name: OracleSourceName = 'chainlink';

  private readonly baseUrl: string;
  protected readonly schema: ProviderSchemaName = 'chainlink';

  constructor() {
    super();
    this.baseUrl = config.sources.chainlink.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = this.toSymbol(asset);
    const response = await httpClient.get<unknown>(`${this.baseUrl}/price`, {
      params: { fsym: symbol, tsym: 'USD', api_key: config.sources.chainlink.apiKey },
    });

    const result = parseProviderResponse(this.schema, response.data, asset);
    if (result.kind === 'no-price') return null;
    if (result.kind === 'invalid-payload') {
      reportInvalidPayload(this.name, asset, result, response.data);
      this.recordInvalidPayload(asset, result.issues);
      return null;
    }

    // This endpoint returns a price but no observation time, so the provider's
    // own timestamp is unavailable. Passing `null` rather than `Date.now()`
    // keeps that gap visible: the resulting price is never counted as
    // age-verified, instead of looking permanently fresh.
    return this.normalizeValidated(asset, result);
  }

  private toSymbol(asset: string): string {
    return asset.toUpperCase();
  }
}
