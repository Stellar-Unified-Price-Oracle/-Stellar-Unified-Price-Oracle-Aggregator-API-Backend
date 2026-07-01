/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class UsageService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * Usage report for a period
     * @param period
     * @returns any Usage report
     * @throws ApiError
     */
    public getApiV1UsageReports(
        period?: 'daily' | 'weekly' | 'monthly',
    ): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/usage/reports',
            query: {
                'period': period,
            },
        });
    }
    /**
     * Usage dashboard (daily/weekly/monthly overview)
     * @returns any Usage dashboard
     * @throws ApiError
     */
    public getApiV1UsageDashboard(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/usage/dashboard',
        });
    }
    /**
     * Detected usage anomalies (request-volume spikes)
     * @returns any Anomaly list
     * @throws ApiError
     */
    public getApiV1UsageAnomalies(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/usage/anomalies',
        });
    }
}
