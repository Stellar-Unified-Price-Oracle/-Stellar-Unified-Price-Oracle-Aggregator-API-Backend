import { providerApiKey } from './sandbox-credentials';
import { randomUUID } from 'crypto';
import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from './capabilities';
import { providerEvidenceArchive } from '../persistence/provider-evidence-archive';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

export class ChainlinkSource extends BaseSource {
  name: OracleSourceName = 'chainlink';
  capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES.find((c) => c.source === 'chainlink')!;

  private readonly baseUrl: string;
  protected readonly schema: ProviderSchemaName = 'chainlink';

  constructor() {
    super();
    this.baseUrl = config.sources.chainlink.baseUrl;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    const symbol = this.toSymbol(asset);
    const response = await httpClient.get<unknown>(`${this.baseUrl}/price`, {
      params: { fsym: symbol, tsym: 'USD', api_key: providerApiKey(this.baseUrl, config.sources.chainlink.apiKey) },
    });

    // Issue #686 — archive the raw provider response (redacted) with a
    // correlation ID for reproducible incident analysis, before any parsing
    // so invalid payloads are captured too.
    providerEvidenceArchive.record({
      correlationId: randomUUID(),
      source: this.name,
      asset,
      providerObservedAt: null,
      requestUrl: `${this.baseUrl}/price`,
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

  private toSymbol(asset: string): string {
    return asset.toUpperCase();
  }
}
