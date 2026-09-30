import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

export class ReflectorSource extends BaseSource {
  name: OracleSourceName = 'reflector';

  private readonly baseUrl: string;
  protected readonly schema: ProviderSchemaName = 'reflector';

  constructor() {
    super();
    this.baseUrl = config.sources.reflector.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = `Crypto.${asset}/USD`;
    const response = await httpClient.get<unknown>(`${this.baseUrl}/v1/prices`, {
      params: { asset: symbol },
    });

    const result = parseProviderResponse(this.schema, response.data, asset);
    if (result.kind === 'no-price') return null;
    if (result.kind === 'invalid-payload') {
      reportInvalidPayload(this.name, asset, result, response.data);
      this.recordInvalidPayload(asset, result.issues);
      return null;
    }

    return this.normalizeValidated(asset, result);
  }
}
