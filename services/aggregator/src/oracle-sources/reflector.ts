import { randomUUID } from 'crypto';
import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from './capabilities';
import { providerEvidenceArchive } from '../persistence/provider-evidence-archive';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

export class ReflectorSource extends BaseSource {
  name: OracleSourceName = 'reflector';
  capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES.find((c) => c.source === 'reflector')!;

  private readonly baseUrl: string;
  protected readonly schema: ProviderSchemaName = 'reflector';

  constructor() {
    super();
    this.baseUrl = config.sources.reflector.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = `Crypto.${asset.toUpperCase()}/USD`;
    const response = await httpClient.get<unknown>(`${this.baseUrl}/v1/prices`, {
      params: { asset: symbol },
    });

    // Issue #686 — archive the raw provider response (redacted) with a
    // correlation ID for reproducible incident analysis.
    providerEvidenceArchive.record({
      correlationId: randomUUID(),
      source: this.name,
      asset,
      providerObservedAt: null,
      requestUrl: `${this.baseUrl}/v1/prices`,
      requestMethod: 'GET',
      responseStatus: response.status,
      responseBody: response.data,
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
