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
      { name: 'Usage', description: 'API usage analytics, reports, and anomaly detection' },
      { name: 'Webhooks', description: 'Webhook registration and delivery for price updates' },
    ],
    paths: {
      '/api/v1': {
        get: {
          tags: ['Prices'],
          summary: 'API root — list available endpoints',
          responses: {
            200: { description: 'Endpoint listing' },
          },
        },
      },
      '/api/v1/prices': {
        get: {
          tags: ['Prices'],
          summary: 'Get all current prices',
          parameters: [
            {
              in: 'query',
              name: 'asset',
              schema: { type: 'string' },
              description: 'Filter by asset symbol (e.g. XLM, BTC)',
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
            200: { description: 'Historical price data' },
            400: { description: 'Invalid parameters' },
          },
        },
      },
      '/api/v1/sources': {
        get: {
          tags: ['Sources'],
          summary: 'List all oracle sources',
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
      '/api/v1/health': {
        get: {
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
          tags: ['Docs'],
          summary: 'Swagger UI documentation',
          responses: {
            200: { description: 'Swagger UI HTML page' },
          },
        },
      },
      '/metrics': {
        get: {
          tags: ['Metrics'],
          summary: 'Prometheus metrics endpoint',
          responses: {
            200: { description: 'Prometheus text format metrics' },
          },
        },
      },
      '/api/v1/usage/reports': {
        get: {
          tags: ['Usage'],
          summary: 'Usage report for a period',
          parameters: [
            { in: 'query', name: 'period', schema: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } },
          ],
          responses: { 200: { description: 'Usage report' } },
        },
      },
      '/api/v1/usage/dashboard': {
        get: {
          tags: ['Usage'],
          summary: 'Usage dashboard (daily/weekly/monthly overview)',
          responses: { 200: { description: 'Usage dashboard' } },
        },
      },
      '/api/v1/usage/anomalies': {
        get: {
          tags: ['Usage'],
          summary: 'Detected usage anomalies (request-volume spikes)',
          responses: { 200: { description: 'Anomaly list' } },
        },
      },
      '/api/v1/webhooks': {
        get: {
          tags: ['Webhooks'],
          summary: 'List registered webhooks',
          responses: { 200: { description: 'Webhook list' } },
        },
        post: {
          tags: ['Webhooks'],
          summary: 'Register a webhook',
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WebhookRegistration' } },
            },
          },
          responses: { 201: { description: 'Webhook created' } },
        },
      },
      '/api/v1/webhooks/{id}': {
        get: { tags: ['Webhooks'], summary: 'Get a webhook', responses: { 200: { description: 'Webhook' } } },
        delete: { tags: ['Webhooks'], summary: 'Delete a webhook', responses: { 204: { description: 'Deleted' } } },
      },
      '/api/v1/webhooks/{id}/deliveries': {
        get: {
          tags: ['Webhooks'],
          summary: 'Webhook delivery log',
          responses: { 200: { description: 'Delivery log entries' } },
        },
      },
    },
    components: {
      schemas: {
        HalLink: {
          type: 'object',
          properties: {
            href: { type: 'string', example: '/api/v1/prices/XLM' },
            method: { type: 'string', example: 'GET' },
            title: { type: 'string' },
          },
        },
        HalLinks: {
          type: 'object',
          description: 'Map of relation name to hypermedia link (self, related, action links)',
          additionalProperties: { $ref: '#/components/schemas/HalLink' },
        },
        WebhookRegistration: {
          type: 'object',
          properties: {
            url: { type: 'string', example: 'https://example.com/webhook' },
            trigger: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['threshold', 'interval'] },
                asset: { type: 'string', example: 'XLM' },
                value: { type: 'number', example: 1.5 },
              },
            },
          },
        },
        AssetPrice: {
          type: 'object',
          properties: {
            asset: { type: 'string', example: 'XLM' },
            price: { type: 'string', example: '10000000000' },
            decimals: { type: 'integer', example: 7 },
            source: { type: 'string', example: 'chainlink' },
            timestamp: { type: 'number', example: 1719000000 },
            _links: { $ref: '#/components/schemas/HalLinks' },
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
      },
    },
  },
  apis: [],
};

export const swaggerSpec = swaggerJsdoc(options);
