/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class MetricsService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * Prometheus metrics endpoint
     * @returns any Prometheus text format metrics
     * @throws ApiError
     */
    public getMetrics(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/metrics',
        });
    }
}
