import {
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLError,
  type GraphQLFieldConfig,
} from 'graphql';
import type { ApiPrice } from '@stellar-oracle/types';
import { readAssetPrices } from '../price-serving/price-store';
import type { HybridCache } from '../price-serving/cache';
import { config } from '../infrastructure/config';
import {
  SCOPE_DENIED_CODE,
  hasFeedScope,
  hasOperationScope,
  type CredentialScope,
} from '../security/credential-scopes';

let graphqlCache: HybridCache<unknown> | null = null;

export function initializeGraphqlCache(cache: HybridCache<unknown>): void {
  graphqlCache = cache;
}

/**
 * GraphQL context carrying the resolved credential scope for the request.
 * When `scope` is undefined the request is treated as unauthenticated and
 * every scoped field is denied.
 */
export interface GraphqlContext {
  scope?: CredentialScope;
}

function scopeDenied(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: SCOPE_DENIED_CODE },
  });
}

function requireOperation(context: GraphqlContext | undefined, operation: string): void {
  if (!hasOperationScope(context?.scope, operation)) {
    throw scopeDenied(`Credential scope does not permit operation '${operation}'`);
  }
}

function requireFeed(context: GraphqlContext | undefined, asset: string | undefined): void {
  if (!hasFeedScope(context?.scope, asset)) {
    throw scopeDenied(
      asset
        ? `Credential scope does not permit feed '${asset}'`
        : 'Credential scope does not permit wildcard feed access',
    );
  }
}

export const PriceType = new GraphQLObjectType({
  name: 'Price',
  fields: {
    asset: { type: GraphQLString },
    price: { type: GraphQLFloat },
    source: { type: GraphQLString },
    updatedAt: { type: GraphQLString },
  },
});

function toPrice(price: ApiPrice) {
  const epochMs = price.timestamp > 1e12 ? price.timestamp : price.timestamp * 1000;
  return {
    asset: price.asset,
    price: Number(price.price),
    source: price.source,
    updatedAt: new Date(epochMs).toISOString(),
  };
}

const priceResolver = async (
  _root: unknown,
  args: { asset?: string; limit?: number },
  context?: GraphqlContext,
) => {
  requireOperation(context, 'read:prices');
  const asset = args.asset?.toUpperCase();
  requireFeed(context, asset);
  const limit = Math.max(1, Math.min(args.limit ?? 10, config.graphql.maxLimit));
  const cacheKey = `graphql:prices:${asset ?? '*'}:l${limit}`;

  if (graphqlCache) {
    const cached = await graphqlCache.get(cacheKey);
    if (cached) return cached;
  }

  const rows = await readAssetPrices();
  const prices = rows
    .filter((row) => !asset || row.asset.toUpperCase() === asset)
    .slice(0, limit)
    .map(toPrice);

  if (graphqlCache) await graphqlCache.set(cacheKey, prices, 'prices');
  return prices;
};

export const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      health: {
        type: GraphQLString,
        resolve: (_root: unknown, _args: unknown, context?: GraphqlContext) => {
          requireOperation(context, 'read:health');
          return 'ok';
        },
      },
      prices: {
        type: new GraphQLList(PriceType),
        args: {
          asset: { type: GraphQLString },
          limit: { type: GraphQLInt },
        },
        resolve: priceResolver,
      } as GraphQLFieldConfig<
        unknown,
        GraphqlContext,
        { asset?: string; limit?: number }
      >,
    },
  }),
});
