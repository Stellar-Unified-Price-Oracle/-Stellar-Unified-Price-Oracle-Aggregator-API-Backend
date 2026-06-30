/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class DocsService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * Swagger UI documentation
     * @returns any Swagger UI HTML page
     * @throws ApiError
     */
    public getDocs(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/docs',
        });
    }
}
