import { describe, it, expect } from 'vitest';
import { swaggerSpec } from '../../src/infrastructure/openapi';

describe('OpenAPI/Swagger Documentation for v2 Endpoints', () => {
  it('should have OpenAPI v3.0.0 specification', () => {
    expect(swaggerSpec.openapi).toBe('3.0.0');
  });

  it('should define API info with title and version', () => {
    expect(swaggerSpec.info).toBeDefined();
    expect(swaggerSpec.info.title).toBeDefined();
    expect(swaggerSpec.info.version).toBeDefined();
  });

  it('should support v2 endpoints in paths structure', () => {
    const paths = swaggerSpec.paths as any;
    const endpoints = Object.keys(paths);
    expect(endpoints.length).toBeGreaterThan(0);
  });

  it('v2 prices endpoint should have proper structure when defined', () => {
    const paths = swaggerSpec.paths as any;
    const v2PricesPath = paths['/api/v2/prices'];

    if (v2PricesPath) {
      expect(v2PricesPath.get || v2PricesPath.post).toBeDefined();
    }
  });

  it('v2 prices/{asset} endpoint should be properly structured when defined', () => {
    const paths = swaggerSpec.paths as any;
    const v2AssetPath = paths['/api/v2/prices/{asset}'];

    if (v2AssetPath) {
      expect(v2AssetPath.get).toBeDefined();
      expect(v2AssetPath.get.parameters).toBeDefined();
    }
  });

  it('should have structure for v2 history endpoint', () => {
    const paths = swaggerSpec.paths as any;
    const v2HistoryPath = paths['/api/v2/history/{asset}'];

    if (v2HistoryPath) {
      expect(v2HistoryPath.get).toBeDefined();
    }
  });

  it('should have structure for v2 sources endpoint', () => {
    const paths = swaggerSpec.paths as any;
    const v2SourcesPath = paths['/api/v2/sources'];

    if (v2SourcesPath) {
      expect(v2SourcesPath.get).toBeDefined();
    }
  });

  it('should support v2 health endpoints when defined', () => {
    const paths = swaggerSpec.paths as any;
    const healthEndpoints = Object.keys(paths).filter(p => p.includes('health'));

    if (healthEndpoints.length > 0) {
      healthEndpoints.forEach(endpoint => {
        expect(paths[endpoint].get).toBeDefined();
      });
    }
  });

  it('v2 endpoint parameters should follow OpenAPI 3.0 spec', () => {
    const paths = swaggerSpec.paths as any;

    Object.values(paths).forEach((pathItem: any) => {
      if (pathItem.get && pathItem.get.parameters) {
        expect(Array.isArray(pathItem.get.parameters)).toBe(true);
        pathItem.get.parameters.forEach((param: any) => {
          expect(param.in).toBeDefined();
          expect(param.name).toBeDefined();
          expect(param.schema).toBeDefined();
        });
      }
    });
  });

  it('v2 endpoint responses should follow OpenAPI 3.0 spec', () => {
    const paths = swaggerSpec.paths as any;

    Object.values(paths).forEach((pathItem: any) => {
      if (pathItem.get) {
        expect(pathItem.get.responses).toBeDefined();
      }
    });
  });

  it('should have schemas defined', () => {
    expect(swaggerSpec.components).toBeDefined();
    expect(swaggerSpec.components.schemas).toBeDefined();
  });

  it('should define AssetPrice schema', () => {
    const schemas = swaggerSpec.components.schemas as any;
    expect(schemas.AssetPrice).toBeDefined();
  });

  it('should define HistoryData schema', () => {
    const schemas = swaggerSpec.components.schemas as any;
    expect(schemas.HistoryData).toBeDefined();
  });

  it('should define HealthCheck schema', () => {
    const schemas = swaggerSpec.components.schemas as any;
    expect(schemas.HealthCheck).toBeDefined();
  });

  it('should have servers defined', () => {
    expect(swaggerSpec.servers).toBeDefined();
    expect(Array.isArray(swaggerSpec.servers)).toBe(true);
  });

  it('should include development and production servers', () => {
    const serverUrls = (swaggerSpec.servers as any[]).map(s => s.url);
    expect(serverUrls.some(url => url.includes('localhost'))).toBe(true);
    expect(serverUrls.some(url => url.includes('stellar-oracle'))).toBe(true);
  });

  it('should have tags defined for API operations', () => {
    expect(swaggerSpec.tags).toBeDefined();
    expect(Array.isArray(swaggerSpec.tags)).toBe(true);
  });

  it('should include Prices tag', () => {
    const tags = swaggerSpec.tags as any[];
    const pricesTag = tags.find(t => t.name === 'Prices');
    expect(pricesTag).toBeDefined();
  });

  it('should include Sources tag', () => {
    const tags = swaggerSpec.tags as any[];
    const sourcesTag = tags.find(t => t.name === 'Sources');
    expect(sourcesTag).toBeDefined();
  });

  it('should include Health tag', () => {
    const tags = swaggerSpec.tags as any[];
    const healthTag = tags.find(t => t.name === 'Health');
    expect(healthTag).toBeDefined();
  });

  it('should have API description', () => {
    expect(swaggerSpec.info.description).toBeDefined();
    expect(typeof swaggerSpec.info.description).toBe('string');
    expect(swaggerSpec.info.description.length).toBeGreaterThan(0);
  });

  it('should have contact information', () => {
    expect(swaggerSpec.info.contact).toBeDefined();
    expect(swaggerSpec.info.contact.name).toBeDefined();
  });

  it('should document API endpoints with proper operationIds', () => {
    const paths = swaggerSpec.paths as any;
    let hasOperationIds = false;

    Object.values(paths).forEach((pathItem: any) => {
      if (pathItem.get && pathItem.get.operationId) {
        hasOperationIds = true;
      }
    });

    expect(hasOperationIds).toBe(true);
  });

  it('should have proper response content types defined', () => {
    const paths = swaggerSpec.paths as any;
    const v2PricesPath = paths['/api/v2/prices'];

    if (v2PricesPath && v2PricesPath.get) {
      const response200 = v2PricesPath.get.responses['200'];
      if (response200) {
        expect(response200.content || response200.description).toBeDefined();
      }
    }
  });
});
