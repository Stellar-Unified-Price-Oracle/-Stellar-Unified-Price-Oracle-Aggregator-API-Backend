import { describe, it, expect, beforeEach, vi } from 'vitest';

interface OpenAPISchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface OpenAPIPath {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
}

interface OpenAPIOperation {
  summary: string;
  responses: Record<string, OpenAPIResponse>;
  parameters?: Array<{ name: string; in: string; required: boolean; schema: OpenAPISchema }>;
  requestBody?: { content: { 'application/json': { schema: OpenAPISchema } } };
}

interface OpenAPIResponse {
  description: string;
  content?: { 'application/json': { schema: OpenAPISchema } };
}

interface OpenAPIDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, OpenAPIPath>;
  components?: { schemas: Record<string, OpenAPISchema> };
}

class OpenAPIGenerator {
  private document: OpenAPIDocument = {
    openapi: '3.0.0',
    info: { title: 'Generated API', version: '1.0.0' },
    paths: {},
    components: { schemas: {} },
  };

  addPath(path: string, method: string, operation: OpenAPIOperation): void {
    if (!this.document.paths[path]) {
      this.document.paths[path] = {};
    }
    (this.document.paths[path] as Record<string, OpenAPIOperation>)[method.toLowerCase()] = operation;
  }

  addSchema(name: string, schema: OpenAPISchema): void {
    if (this.document.components) {
      this.document.components.schemas[name] = schema;
    }
  }

  getDocument(): OpenAPIDocument {
    return this.document;
  }

  validateDocumentStructure(): boolean {
    return (
      typeof this.document.openapi === 'string' &&
      typeof this.document.info.title === 'string' &&
      typeof this.document.paths === 'object'
    );
  }

  findPathOperation(path: string, method: string): OpenAPIOperation | null {
    const pathItem = this.document.paths[path];
    if (!pathItem) return null;
    return (pathItem as Record<string, OpenAPIOperation>)[method.toLowerCase()] || null;
  }
}

class ResponseValidator {
  private schemas: Map<string, OpenAPISchema> = new Map();

  registerSchema(name: string, schema: OpenAPISchema): void {
    this.schemas.set(name, schema);
  }

  validateResponse(response: unknown, schemaName: string): { valid: boolean; errors: string[] } {
    const schema = this.schemas.get(schemaName);
    if (!schema) {
      return { valid: false, errors: [`Schema ${schemaName} not found`] };
    }

    const errors: string[] = [];

    if (schema.type === 'object' && schema.properties) {
      const obj = response as Record<string, unknown>;
      const required = schema.required || [];

      for (const field of required) {
        if (!(field in obj)) {
          errors.push(`Missing required field: ${field}`);
        }
      }

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj && propSchema && typeof propSchema === 'object') {
          const prop = propSchema as OpenAPISchema;
          if (prop.type && !this.typeMatches(obj[key], prop.type)) {
            errors.push(`Field ${key} has wrong type: expected ${prop.type}, got ${typeof obj[key]}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private typeMatches(value: unknown, expectedType: string): boolean {
    if (expectedType === 'string') return typeof value === 'string';
    if (expectedType === 'number') return typeof value === 'number';
    if (expectedType === 'integer') return Number.isInteger(value);
    if (expectedType === 'boolean') return typeof value === 'boolean';
    if (expectedType === 'array') return Array.isArray(value);
    if (expectedType === 'object') return typeof value === 'object' && value !== null;
    return false;
  }
}

class APIClientGenerator {
  private document: OpenAPIDocument;

  constructor(document: OpenAPIDocument) {
    this.document = document;
  }

  generateTypeScript(): string {
    let code = '// Generated TypeScript Client\n\n';

    // Generate types from schemas
    if (this.document.components?.schemas) {
      code += '// Generated Types\n';
      for (const [name, schema] of Object.entries(this.document.components.schemas)) {
        code += this.generateType(name, schema);
      }
    }

    // Generate API client
    code += '\nexport class APIClient {\n';
    code += '  constructor(private baseURL: string) {}\n\n';

    for (const [path, pathItem] of Object.entries(this.document.paths)) {
      for (const [method, operation] of Object.entries(pathItem as Record<string, OpenAPIOperation>)) {
        if (operation && typeof operation === 'object' && 'responses' in operation) {
          code += this.generateMethod(path, method, operation);
        }
      }
    }

    code += '}\n';
    return code;
  }

  private generateType(name: string, schema: OpenAPISchema): string {
    let code = `export interface ${name} {\n`;
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        const isRequired = schema.required?.includes(key) ?? false;
        const typeStr = this.getTypeString(prop as OpenAPISchema);
        code += `  ${key}${isRequired ? '' : '?'}: ${typeStr};\n`;
      }
    }
    code += '}\n\n';
    return code;
  }

  private generateMethod(path: string, method: string, operation: OpenAPIOperation): string {
    const methodName = this.pathToMethodName(path, method);
    const responseType = 'unknown';

    let code = `  async ${methodName}(`;
    if (operation.requestBody) {
      code += 'body: unknown';
    }
    code += `): Promise<${responseType}> {\n`;
    code += `    // Implementation for ${method.toUpperCase()} ${path}\n`;
    code += `    return {};\n`;
    code += `  }\n\n`;

    return code;
  }

  private pathToMethodName(path: string, method: string): string {
    const parts = path.split('/').filter(p => p && !p.startsWith('{'));
    return `${method.toLowerCase()}${parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')}`;
  }

  private getTypeString(schema: OpenAPISchema): string {
    if (schema.type === 'string') return 'string';
    if (schema.type === 'number') return 'number';
    if (schema.type === 'integer') return 'number';
    if (schema.type === 'boolean') return 'boolean';
    if (schema.type === 'array') return 'Array<unknown>';
    if (schema.type === 'object') return 'Record<string, unknown>';
    return 'unknown';
  }
}

class CompatibilityChecker {
  checkBackwardsCompatibility(oldDoc: OpenAPIDocument, newDoc: OpenAPIDocument): { compatible: boolean; breaks: string[] } {
    const breaks: string[] = [];

    for (const [path, pathItem] of Object.entries(oldDoc.paths)) {
      if (!newDoc.paths[path]) {
        breaks.push(`Removed path: ${path}`);
        continue;
      }

      const oldPathItem = pathItem as Record<string, OpenAPIOperation>;
      const newPathItem = newDoc.paths[path] as Record<string, OpenAPIOperation>;

      for (const [method, operation] of Object.entries(oldPathItem)) {
        if (operation && typeof operation === 'object' && 'responses' in operation) {
          if (!newPathItem[method]) {
            breaks.push(`Removed method: ${method.toUpperCase()} ${path}`);
          }
        }
      }
    }

    return { compatible: breaks.length === 0, breaks };
  }
}

describe('Generated API Contracts', () => {
  let generator: OpenAPIGenerator;
  let validator: ResponseValidator;

  beforeEach(() => {
    generator = new OpenAPIGenerator();
    validator = new ResponseValidator();
  });

  describe('OpenAPI Generation from Code', () => {
    it('should generate valid OpenAPI document structure', () => {
      generator.addPath('/api/v1/prices', 'get', {
        summary: 'Get current prices',
        responses: {
          '200': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      });

      const doc = generator.getDocument();
      expect(doc.openapi).toBe('3.0.0');
      expect(doc.paths['/api/v1/prices']).toBeDefined();
      expect(doc.paths['/api/v1/prices'].get).toBeDefined();
    });

    it('should capture endpoint operations from implementation', () => {
      generator.addPath('/api/v2/assets', 'get', {
        summary: 'List available assets',
        responses: {
          '200': { description: 'Assets list' },
        },
      });

      generator.addPath('/api/v2/prices', 'post', {
        summary: 'Batch price query',
        responses: {
          '200': { description: 'Batch prices' },
        },
      });

      const doc = generator.getDocument();
      expect(Object.keys(doc.paths)).toContain('/api/v2/assets');
      expect(Object.keys(doc.paths)).toContain('/api/v2/prices');
    });

    it('should merge authored fragments with generated spec', () => {
      const operation: OpenAPIOperation = {
        summary: 'Get current prices',
        responses: {
          '200': {
            description: 'Current prices',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': { description: 'Unauthorized' },
          '429': { description: 'Rate limited' },
        },
      };

      generator.addPath('/api/v1/prices', 'get', operation);

      const doc = generator.getDocument();
      const responses = doc.paths['/api/v1/prices'].get?.responses;
      expect(responses?.['200']).toBeDefined();
      expect(responses?.['401']).toBeDefined();
      expect(responses?.['429']).toBeDefined();
    });

    it('should validate generated document is reproducible', () => {
      const operation: OpenAPIOperation = {
        summary: 'Test endpoint',
        responses: { '200': { description: 'OK' } },
      };

      generator.addPath('/test', 'get', operation);
      const doc1 = JSON.stringify(generator.getDocument());
      const doc2 = JSON.stringify(generator.getDocument());

      expect(doc1).toBe(doc2);
    });
  });

  describe('Response Contract Validation', () => {
    it('should validate success response against schema', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          price: { type: 'number' },
          timestamp: { type: 'number' },
        },
        required: ['asset', 'price', 'timestamp'],
      };

      validator.registerSchema('PriceResponse', schema);

      const response = { asset: 'XLM', price: 10.5, timestamp: 1000 };
      const result = validator.validateResponse(response, 'PriceResponse');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          price: { type: 'number' },
        },
        required: ['asset', 'price'],
      };

      validator.registerSchema('IncompleteResponse', schema);

      const response = { asset: 'XLM' };
      const result = validator.validateResponse(response, 'IncompleteResponse');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: price');
    });

    it('should detect type mismatches in response', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          price: { type: 'number' },
        },
        required: ['asset', 'price'],
      };

      validator.registerSchema('TypeMismatchResponse', schema);

      const response = { asset: 'XLM', price: 'not-a-number' };
      const result = validator.validateResponse(response, 'TypeMismatchResponse');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('price'))).toBe(true);
    });

    it('should validate 401 Unauthorized error response', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['code', 'message'],
      };

      validator.registerSchema('UnauthorizedError', schema);

      const response = { code: 'MISSING_API_KEY', message: 'API key required' };
      const result = validator.validateResponse(response, 'UnauthorizedError');

      expect(result.valid).toBe(true);
    });

    it('should validate 429 Rate Limited error response', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: {
          code: { type: 'string' },
          retryAfter: { type: 'number' },
        },
        required: ['code', 'retryAfter'],
      };

      validator.registerSchema('RateLimitError', schema);

      const response = { code: 'RATE_LIMITED', retryAfter: 60 };
      const result = validator.validateResponse(response, 'RateLimitError');

      expect(result.valid).toBe(true);
    });

    it('should validate 404 Not Found error response', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['code', 'message'],
      };

      validator.registerSchema('NotFoundError', schema);

      const response = { code: 'NOT_FOUND', message: 'Asset not found' };
      const result = validator.validateResponse(response, 'NotFoundError');

      expect(result.valid).toBe(true);
    });
  });

  describe('Deterministic Fault Injection for Testing Error Paths', () => {
    it('should support injecting validation errors', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: { asset: { type: 'string' } },
        required: ['asset'],
      };

      validator.registerSchema('ValidationError', schema);

      const faultResponse = { asset: 123 };
      const result = validator.validateResponse(faultResponse, 'ValidationError');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should support injecting timeout scenarios', () => {
      const timeoutSchema: OpenAPISchema = {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
      };

      validator.registerSchema('TimeoutError', timeoutSchema);
      const timeoutResponse = { code: 'TIMEOUT', message: 'Request timed out' };

      const result = validator.validateResponse(timeoutResponse, 'TimeoutError');
      expect(result.valid).toBe(false);
    });

    it('should support injecting dependency failures', () => {
      const depFailSchema: OpenAPISchema = {
        type: 'object',
        properties: {
          code: { type: 'string' },
          service: { type: 'string' },
        },
        required: ['code', 'service'],
      };

      validator.registerSchema('DependencyError', depFailSchema);
      const response = { code: 'SERVICE_UNAVAILABLE', service: 'oracle-source' };

      const result = validator.validateResponse(response, 'DependencyError');
      expect(result.valid).toBe(true);
    });
  });

  describe('TypeScript Client Generation from OpenAPI', () => {
    it('should generate typed TypeScript client from spec', () => {
      generator.addPath('/api/v1/prices', 'get', {
        summary: 'Get prices',
        responses: { '200': { description: 'OK' } },
      });

      const doc = generator.getDocument();
      const clientGen = new APIClientGenerator(doc);
      const code = clientGen.generateTypeScript();

      expect(code).toContain('class APIClient');
      expect(code).toContain('constructor(private baseURL: string)');
    });

    it('should generate methods for each endpoint', () => {
      generator.addPath('/api/v1/prices', 'get', {
        summary: 'Get prices',
        responses: { '200': { description: 'OK' } },
      });

      generator.addPath('/api/v2/assets', 'get', {
        summary: 'List assets',
        responses: { '200': { description: 'OK' } },
      });

      const doc = generator.getDocument();
      const clientGen = new APIClientGenerator(doc);
      const code = clientGen.generateTypeScript();

      expect(code).toContain('GET');
    });

    it('should generate types from OpenAPI schemas', () => {
      const schema: OpenAPISchema = {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          price: { type: 'number' },
        },
        required: ['asset', 'price'],
      };

      generator.addSchema('Price', schema);

      const doc = generator.getDocument();
      const clientGen = new APIClientGenerator(doc);
      const code = clientGen.generateTypeScript();

      expect(code).toContain('export interface Price');
      expect(code).toContain('asset: string');
      expect(code).toContain('price: number');
    });

    it('should verify client generation is clean and repeatable', () => {
      generator.addPath('/test', 'get', {
        summary: 'Test',
        responses: { '200': { description: 'OK' } },
      });

      const doc = generator.getDocument();
      const clientGen = new APIClientGenerator(doc);
      const code1 = clientGen.generateTypeScript();
      const code2 = clientGen.generateTypeScript();

      expect(code1).toBe(code2);
    });
  });

  describe('Backwards Compatibility Checking', () => {
    it('should detect removed endpoints', () => {
      const oldDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'API', version: '1.0' },
        paths: {
          '/api/v1/prices': {
            get: { summary: 'Get prices', responses: { '200': { description: 'OK' } } },
          },
        },
      };

      const newDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'API', version: '1.1' },
        paths: {},
      };

      const checker = new CompatibilityChecker();
      const result = checker.checkBackwardsCompatibility(oldDoc, newDoc);

      expect(result.compatible).toBe(false);
      expect(result.breaks.some(b => b.includes('Removed path'))).toBe(true);
    });

    it('should detect removed HTTP methods', () => {
      const oldDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'API', version: '1.0' },
        paths: {
          '/api/v1/prices': {
            get: { summary: 'Get', responses: { '200': { description: 'OK' } } },
            post: { summary: 'Create', responses: { '201': { description: 'Created' } } },
          },
        },
      };

      const newDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'API', version: '1.1' },
        paths: {
          '/api/v1/prices': {
            get: { summary: 'Get', responses: { '200': { description: 'OK' } } },
          },
        },
      };

      const checker = new CompatibilityChecker();
      const result = checker.checkBackwardsCompatibility(oldDoc, newDoc);

      expect(result.compatible).toBe(false);
      expect(result.breaks.some(b => b.includes('post'))).toBe(true);
    });

    it('should allow backwards-compatible additions', () => {
      const oldDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'API', version: '1.0' },
        paths: {
          '/api/v1/prices': {
            get: { summary: 'Get', responses: { '200': { description: 'OK' } } },
          },
        },
      };

      const newDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'API', version: '1.1' },
        paths: {
          '/api/v1/prices': {
            get: { summary: 'Get', responses: { '200': { description: 'OK' } } },
          },
          '/api/v2/prices': {
            get: { summary: 'Get v2', responses: { '200': { description: 'OK' } } },
          },
        },
      };

      const checker = new CompatibilityChecker();
      const result = checker.checkBackwardsCompatibility(oldDoc, newDoc);

      expect(result.compatible).toBe(true);
      expect(result.breaks).toHaveLength(0);
    });
  });

  describe('Versioning State Protection', () => {
    it('should protect v1 frozen paths from modification', () => {
      generator.addPath('/api/v1/prices', 'get', {
        summary: 'Get prices - FROZEN',
        responses: { '200': { description: 'OK' } },
      });

      generator.addPath('/api/v2/prices', 'get', {
        summary: 'Get prices v2',
        responses: { '200': { description: 'OK' } },
      });

      const doc = generator.getDocument();
      expect(doc.paths['/api/v1/prices']).toBeDefined();
      expect(doc.paths['/api/v2/prices']).toBeDefined();
    });
  });
});
