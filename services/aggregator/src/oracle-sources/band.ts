import { randomUUID } from 'crypto';
import { httpClient } from '../infrastructure/http-client';
import { config } from '../infrastructure/config';
import { NormalizedPrice, OracleSourceName } from '../infrastructure/types';
import { BaseSource } from './base';
import { resolveDecimals } from './decimals';
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from './capabilities';
import { providerEvidenceArchive } from '../persistence/provider-evidence-archive';
import { parseProviderResponse, reportInvalidPayload, type ProviderSchemaName } from './response-validation';

interface BandFeedData {
  price: string;
  decimals?: number;
  updated_at?: number;
}

export class BandSource extends BaseSource {
  name: OracleSourceName = 'band';
  capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES.find((c) => c.source === 'band')!;

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

    // Issue #686 — archive the raw provider response (redacted) with a
    // correlation ID for reproducible incident analysis.
    providerEvidenceArchive.record({
      correlationId: randomUUID(),
      source: this.name,
      asset,
      providerObservedAt: null,
      requestUrl: `${this.baseUrl}/oracle/v1/feeds/${symbol}`,
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

    const decimals = resolveDecimals(this.name, response.data.data.decimals);

    // Band reports the provider's own update time; keep it as `observedAt`
    // rather than falling back to local fetch time when it is missing.
    return this.normalize(
      asset,
      response.data.data.price,
      decimals,
      response.data.data.updated_at ?? null,
    );
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
