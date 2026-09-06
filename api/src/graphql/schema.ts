import {
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfig,
} from 'graphql';

export const PriceType = new GraphQLObjectType({
  name: 'Price',
  fields: {
    asset: { type: GraphQLString },
    price: { type: GraphQLFloat },
    source: { type: GraphQLString },
    updatedAt: { type: GraphQLString },
  },
});

const priceResolver = (_root: unknown, args: { asset?: string; limit?: number }) => {
  const asset = args.asset?.toUpperCase() || 'XLM';
  const limit = Math.max(1, Math.min(args.limit ?? 10, 25));
  const basePrice = asset === 'BTC' ? 72840.12 : asset === 'ETH' ? 3521.9 : 0.46;

  return Array.from({ length: limit }, (_, index) => ({
    asset,
    price: Number((basePrice + index * 0.11).toFixed(6)),
    source: 'internal-graphql',
    updatedAt: new Date().toISOString(),
  }));
};

export const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      health: {
        type: GraphQLString,
        resolve: () => 'ok',
      },
      prices: {
        type: new GraphQLList(PriceType),
        args: {
          asset: { type: GraphQLString },
          limit: { type: GraphQLInt },
        },
        resolve: priceResolver,
      } as GraphQLFieldConfig<unknown, unknown, { asset?: string; limit?: number }>,
    },
  }),
});
