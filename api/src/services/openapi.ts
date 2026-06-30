import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Stellar Unified Price Oracle & Aggregator API',
      version: '1.0.0',
      description: `A Soroban-based price oracle aggregator that pulls from Chainlink, Redstone, Band, and Reflector, normalizes the data, and exposes it through a single clean API endpoint.

## Features
- Multi-source price aggregation with median calculation
- Real-time price updates via WebSocket
- Historical price data queries
- Prometheus metrics
- Per-asset confidence scoring
      `,
      contact: {
        name: 'Stellar Price Oracle',
        url: 'https://github.com/stellar-oracle',
      },
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Development' },
      { url: 'https://api.stellar-oracle.io', description: 'Production' },
    ],
    tags: [
      { name: 'Prices', description: 'Current and historical price data' },
      { name: 'Sources', description: 'Oracle source information' },
      { name: 'Health', description: 'Service health checks' },
      { name: 'Metrics', description: 'Prometheus monitoring' },
    ],
    paths: {
      '/api/v1': {
        get: {
          operationId: 'getApiRoot',
          tags: ['Prices'],
          summary: 'API root — list available endpoints',
          responses: {
            200: { description: 'Endpoint listing' },
          },
        },
      },
      '/api/v1/prices': {
        get: {
          operationId: 'getPrices',
          tags: ['Prices'],
          summary: 'Get all current prices',
          parameters: [
            {
              in: 'query',
              name: 'asset',
              schema: { type: 'string' },
              description: 'Filter by asset symbol (e.g. XLM, BTC)',
            },
            {
              in: 'query',
              name: 'page',
              schema: { type: 'integer', minimum: 1, default: 1 },
              description: 'Page number for offset pagination',
            },
            {
              in: 'query',
              name: 'limit',
              schema: { type: 'integer', minimum: 1, default: 20 },
              description: 'Items per page',
            },
          ],
          responses: {
            200: {
              description: 'Array of current prices',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          timestamp: { type: 'number' },
                          count: { type: 'integer' },
                          prices: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AssetPrice' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'Invalid query parameters' },
          },
        },
      },
      '/api/v1/prices/{asset}': {
        get: {
          operationId: 'getPriceByAsset',
          tags: ['Prices'],
          summary: 'Get current price for a specific asset',
          parameters: [
            {
              in: 'path',
              name: 'asset',
              required: true,
              schema: { type: 'string' },
              description: 'Asset symbol (XLM, BTC, ETH, USDC, USDT)',
            },
          ],
          responses: {
            200: {
              description: 'Price data for the requested asset',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { $ref: '#/components/schemas/AssetPrice' },
                    },
                  },
                },
              },
            },
            404: { description: 'Asset not found' },
          },
        },
      },
      '/api/v1/history/{asset}': {
        get: {
          operationId: 'getPriceHistory',
          tags: ['Prices'],
          summary: 'Get historical prices for an asset',
          parameters: [
            {
              in: 'path',
              name: 'asset',
              required: true,
              schema: { type: 'string' },
              description: 'Asset symbol',
            },
            {
              in: 'query',
              name: 'cursor',
              schema: { type: 'string' },
              description: 'Opaque cursor from a previous response',
            },
            {
              in: 'query',
              name: 'from',
              schema: { type: 'number' },
              description: 'Start timestamp (Unix seconds)',
            },
            {
              in: 'query',
              name: 'to',
              schema: { type: 'number' },
              description: 'End timestamp (Unix seconds)',
            },
            {
              in: 'query',
              name: 'limit',
              schema: { type: 'integer', default: 100 },
              description: 'Maximum number of records',
            },
          ],
          responses: {
            200: {
              description: 'Historical price data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { $ref: '#/components/schemas/HistoryData' },
                      cached: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            400: { description: 'Invalid parameters' },
          },
        },
      },
      '/api/v1/sources': {
        get: {
          operationId: 'getSources',
          tags: ['Sources'],
          summary: 'List all oracle sources',
          parameters: [
            {
              in: 'query',
              name: 'page',
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              in: 'query',
              name: 'limit',
              schema: { type: 'integer', minimum: 1, default: 20 },
            },
          ],
          responses: {
            200: {
              description: 'Active oracle sources',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          sources: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/OracleSource' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/health/live': {
        get: {
          operationId: 'getHealthLive',
          tags: ['Health'],
          summary: 'Liveness probe',
          responses: {
            200: {
              description: 'Service is alive',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LivenessCheck' },
                },
              },
            },
          },
        },
      },
      '/api/v1/health/ready': {
        get: {
          operationId: 'getHealthReady',
          tags: ['Health'],
          summary: 'Readiness probe',
          responses: {
            200: {
              description: 'Service is ready',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReadinessCheck' },
                },
              },
            },
            503: {
              description: 'Service is not ready',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReadinessCheck' },
                },
              },
            },
          },
        },
      },
      '/api/v1/health': {
        get: {
          operationId: 'getHealth',
          tags: ['Health'],
          summary: 'Health check endpoint',
          responses: {
            200: {
              description: 'Service health status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { $ref: '#/components/schemas/HealthCheck' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/docs': {
        get: {
          operationId: 'getDocs',
          tags: ['Docs'],
          summary: 'Swagger UI documentation',
          responses: {
            200: { description: 'Swagger UI HTML page' },
          },
        },
      },
      '/metrics': {
        get: {
          operationId: 'getMetrics',
          tags: ['Metrics'],
          summary: 'Prometheus metrics endpoint',
          responses: {
            200: { description: 'Prometheus text format metrics' },
          },
        },
      },
    },
    components: {
      schemas: {
        AssetPrice: {
          type: 'object',
          properties: {
            asset: { type: 'string', example: 'XLM' },
            price: { type: 'string', example: '10000000000' },
            decimals: { type: 'integer', example: 7 },
            source: { type: 'string', example: 'chainlink' },
            timestamp: { type: 'number', example: 1719000000 },
          },
        },
        OracleSource: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'Chainlink' },
            active: { type: 'boolean', example: true },
            type: { type: 'string', example: 'off-chain' },
            website: { type: 'string', example: 'https://chain.link' },
          },
        },
        HealthCheck: {
          type: 'object',
          properties: {
            service: { type: 'string', example: 'stellar-price-oracle-api' },
            status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
            uptime: { type: 'number', example: 3600 },
            timestamp: { type: 'number', example: 1719000000 },
            assetsTracked: { type: 'integer', example: 5 },
          },
        },
        LivenessCheck: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'alive' },
            uptime: { type: 'number', example: 3600 },
          },
        },
        ReadinessCheck: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ready', 'not_ready'] },
            assetsTracked: { type: 'integer', example: 5 },
          },
        },
        PaginationMeta: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
            hasNext: { type: 'boolean' },
            hasPrev: { type: 'boolean' },
          },
        },
        CursorPaginationMeta: {
          type: 'object',
          properties: {
            limit: { type: 'integer' },
            nextCursor: { type: 'string', nullable: true },
            hasMore: { type: 'boolean' },
          },
        },
        HistoryEntry: {
          type: 'object',
          properties: {
            price: { type: 'string' },
            decimals: { type: 'integer' },
            source: { type: 'string' },
            timestamp: { type: 'number' },
          },
        },
        HistoryData: {
          type: 'object',
          properties: {
            asset: { type: 'string' },
            to: { type: 'number', nullable: true },
            prices: {
              type: 'array',
              items: { $ref: '#/components/schemas/HistoryEntry' },
            },
            pagination: { $ref: '#/components/schemas/CursorPaginationMeta' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  },
  apis: [],
};

export const swaggerSpec = swaggerJsdoc(options);
