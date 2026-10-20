import { randomUUID } from 'crypto';
import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { resolveDecimals } from './decimals';
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from './capabilities';
import { providerEvidenceArchive } from '../persistence/provider-evidence-archive';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

interface RedstonePriceData {
  value: string | number;
  decimals?: number;
}

type RedstonePricesResponse = Record<string, RedstonePriceData | undefined>;

export class RedstoneSource extends BaseSource {
  name: OracleSourceName = 'redstone';
  capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES.find((c) => c.source === 'redstone')!;

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

    // Issue #686 — archive the raw provider response (redacted) with a
    // correlation ID for reproducible incident analysis.
    providerEvidenceArchive.record({
      correlationId: randomUUID(),
      source: this.name,
      asset: symbol,
      providerObservedAt: null,
      requestUrl: `${this.baseUrl}/prices`,
      requestMethod: 'GET',
      responseStatus: response.status,
      responseBody: response.data,
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
    return this.normalize(asset, data.value, resolveDecimals(this.name, data.decimals), null);
  }
}
