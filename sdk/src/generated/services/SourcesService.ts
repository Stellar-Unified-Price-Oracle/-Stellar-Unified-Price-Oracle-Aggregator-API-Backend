/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { OracleSource } from '../models/OracleSource';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class SourcesService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * List all oracle sources
     * @param page
     * @param limit
     * @returns any Active oracle sources
     * @throws ApiError
     */
    public getSources(
        page: number = 1,
        limit: number = 20,
    ): CancelablePromise<{
        success?: boolean;
        data?: {
            sources?: Array<OracleSource>;
        };
    }> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/sources',
            query: {
                'page': page,
                'limit': limit,
            },
        });
    }
}
