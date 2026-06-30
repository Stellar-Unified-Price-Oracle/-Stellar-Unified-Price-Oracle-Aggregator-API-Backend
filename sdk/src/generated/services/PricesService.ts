/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AssetPrice } from '../models/AssetPrice';
import type { HistoryData } from '../models/HistoryData';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class PricesService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * API root — list available endpoints
     * @returns any Endpoint listing
     * @throws ApiError
     */
    public getApiRoot(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1',
        });
    }
    /**
     * Get all current prices
     * @param asset Filter by asset symbol (e.g. XLM, BTC)
     * @param page Page number for offset pagination
     * @param limit Items per page
     * @returns any Array of current prices
     * @throws ApiError
     */
    public getPrices(
        asset?: string,
        page: number = 1,
        limit: number = 20,
    ): CancelablePromise<{
        success?: boolean;
        data?: {
            timestamp?: number;
            count?: number;
            prices?: Array<AssetPrice>;
        };
    }> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/prices',
            query: {
                'asset': asset,
                'page': page,
                'limit': limit,
            },
            errors: {
                400: `Invalid query parameters`,
            },
        });
    }
    /**
     * Get current price for a specific asset
     * @param asset Asset symbol (XLM, BTC, ETH, USDC, USDT)
     * @returns any Price data for the requested asset
     * @throws ApiError
     */
    public getPriceByAsset(
        asset: string,
    ): CancelablePromise<{
        success?: boolean;
        data?: AssetPrice;
    }> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/prices/{asset}',
            path: {
                'asset': asset,
            },
            errors: {
                404: `Asset not found`,
            },
        });
    }
    /**
     * Get historical prices for an asset
     * @param asset Asset symbol
     * @param cursor Opaque cursor from a previous response
     * @param from Start timestamp (Unix seconds)
     * @param to End timestamp (Unix seconds)
     * @param limit Maximum number of records
     * @returns any Historical price data
     * @throws ApiError
     */
    public getPriceHistory(
        asset: string,
        cursor?: string,
        from?: number,
        to?: number,
        limit: number = 100,
    ): CancelablePromise<{
        success?: boolean;
        data?: HistoryData;
        cached?: boolean;
    }> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/v1/history/{asset}',
            path: {
                'asset': asset,
            },
            query: {
                'cursor': cursor,
                'from': from,
                'to': to,
                'limit': limit,
            },
            errors: {
                400: `Invalid parameters`,
            },
        });
    }
}
