import { createLineageForPrice } from '../../platform/lineage';
import type { PriceProvenance, OracleSourceName } from '@stellar-oracle/types';

const DEFAULT_CATALOG_VERSION = process.env.PRICE_CATALOG_VERSION || '1.0.0';
const AGGREGATION_MIN_SOURCES = 1;
const AGGREGATION_STRATEGY = 'median';

/** Build a price-provenance response linking a price to its production lineage. */
export function buildPriceProvenance(
  price: Record<string, unknown>,
  baseUrl = '/api/v1',
): PriceProvenance {
  const asset = String(price.asset || '').toUpperCase();
  const sources: OracleSourceName[] = Array.isArray(price.sources)
    ? (price.sources as OracleSourceName[])
    : [(price.source as OracleSourceName) || 'chainlink'];
  const timestamp = Number(price.timestamp) || 0;
  const observedAt =
    price.observedAt !== undefined ? Number(price.observedAt) : null;
  const fetchedAt =
    price.fetchedAt !== undefined ? Number(price.fetchedAt) : null;

  // ageVerified only when every contributing source reported its own observation time
  const ageVerified = sources.every(
    () => price.observedAt !== undefined && price.observedAt !== null,
  );

  const lineage = createLineageForPrice(
    {
      asset,
      price: price.price,
      decimals: price.decimals,
      sources,
      timestamp,
      observedAt,
    },
    baseUrl,
  );

  return {
    asset,
    price: String(price.price ?? ''),
    decimals: Number(price.decimals) || 8,
    timestamp,
    observedAt: observedAt ?? null,
    catalogVersion: DEFAULT_CATALOG_VERSION,
    aggregationPolicy: {
      strategy: AGGREGATION_STRATEGY,
      sourceCount: sources.length,
      minSources: AGGREGATION_MIN_SOURCES,
    },
    sourceSet: sources,
    observationTimeSemantics: {
      observedAt: observedAt ?? null,
      fetchedAt: fetchedAt ?? null,
      ageVerified,
    },
    provenanceId: lineage.provenance_id,
    verificationUrl: lineage.verification_url,
  };
}

export { DEFAULT_CATALOG_VERSION as catalogVersion };
export { AGGREGATION_STRATEGY as aggregationStrategy };
export { AGGREGATION_MIN_SOURCES as minSources };