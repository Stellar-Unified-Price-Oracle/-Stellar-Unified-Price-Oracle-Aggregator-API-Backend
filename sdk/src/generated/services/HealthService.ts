/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { HealthCheck } from '../models/HealthCheck';
import type { LivenessCheck } from '../models/LivenessCheck';
import type { ReadinessCheck } from '../models/ReadinessCheck';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class HealthService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * Liveness probe
     * @returns LivenessCheck Service is alive
     * @throws ApiError
     */
    public getHealthLive(): CancelablePromise<LivenessCheck> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/health/live',
        });
    }
    /**
     * Readiness probe
     * @returns ReadinessCheck Service is ready
     * @throws ApiError
     */
    public getHealthReady(): CancelablePromise<ReadinessCheck> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/health/ready',
            errors: {
                503: `Service is not ready`,
            },
        });
    }
    /**
     * Health check endpoint
     * @returns any Service health status
     * @throws ApiError
     */
    public getHealth(): CancelablePromise<{
        success?: boolean;
        data?: HealthCheck;
    }> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/health',
        });
    }
}
