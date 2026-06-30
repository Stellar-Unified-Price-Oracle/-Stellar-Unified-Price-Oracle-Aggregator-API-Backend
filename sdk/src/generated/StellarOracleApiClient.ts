/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseHttpRequest } from './core/BaseHttpRequest';
import type { OpenAPIConfig } from './core/OpenAPI';
import { FetchHttpRequest } from './core/FetchHttpRequest';
import { DocsService } from './services/DocsService';
import { HealthService } from './services/HealthService';
import { MetricsService } from './services/MetricsService';
import { PricesService } from './services/PricesService';
import { SourcesService } from './services/SourcesService';
type HttpRequestConstructor = new (config: OpenAPIConfig) => BaseHttpRequest;
export class StellarOracleApiClient {
    public readonly docs: DocsService;
    public readonly health: HealthService;
    public readonly metrics: MetricsService;
    public readonly prices: PricesService;
    public readonly sources: SourcesService;
    public readonly request: BaseHttpRequest;
    constructor(config?: Partial<OpenAPIConfig>, HttpRequest: HttpRequestConstructor = FetchHttpRequest) {
        this.request = new HttpRequest({
            BASE: config?.BASE ?? 'http://localhost:3000',
            VERSION: config?.VERSION ?? '1.0.0',
            WITH_CREDENTIALS: config?.WITH_CREDENTIALS ?? false,
            CREDENTIALS: config?.CREDENTIALS ?? 'include',
            TOKEN: config?.TOKEN,
            USERNAME: config?.USERNAME,
            PASSWORD: config?.PASSWORD,
            HEADERS: config?.HEADERS,
            ENCODE_PATH: config?.ENCODE_PATH,
        });
        this.docs = new DocsService(this.request);
        this.health = new HealthService(this.request);
        this.metrics = new MetricsService(this.request);
        this.prices = new PricesService(this.request);
        this.sources = new SourcesService(this.request);
    }
}

