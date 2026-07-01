/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { WebhookRegistration } from '../models/WebhookRegistration';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class WebhooksService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * List registered webhooks
     * @returns any Webhook list
     * @throws ApiError
     */
    public getApiV1Webhooks(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/webhooks',
        });
    }
    /**
     * Register a webhook
     * @param requestBody
     * @returns any Webhook created
     * @throws ApiError
     */
    public postApiV1Webhooks(
        requestBody?: WebhookRegistration,
    ): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/v1/webhooks',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Get a webhook
     * @returns any Webhook
     * @throws ApiError
     */
    public getApiV1Webhooks1(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/webhooks/{id}',
        });
    }
    /**
     * Delete a webhook
     * @returns void
     * @throws ApiError
     */
    public deleteApiV1Webhooks(): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/v1/webhooks/{id}',
        });
    }
    /**
     * Webhook delivery log
     * @returns any Delivery log entries
     * @throws ApiError
     */
    public getApiV1WebhooksDeliveries(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/webhooks/{id}/deliveries',
        });
    }
}
