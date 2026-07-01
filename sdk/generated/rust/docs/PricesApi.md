# \PricesApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_api_root**](PricesApi.md#get_api_root) | **GET** /api/v1 | API root — list available endpoints
[**get_price_by_asset**](PricesApi.md#get_price_by_asset) | **GET** /api/v1/prices/{asset} | Get current price for a specific asset
[**get_price_history**](PricesApi.md#get_price_history) | **GET** /api/v1/history/{asset} | Get historical prices for an asset
[**get_prices**](PricesApi.md#get_prices) | **GET** /api/v1/prices | Get all current prices



## get_api_root

> get_api_root()
API root — list available endpoints

### Parameters

This endpoint does not need any parameter.

### Return type

 (empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_price_by_asset

> models::GetPriceByAsset200Response get_price_by_asset(asset)
Get current price for a specific asset

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**asset** | **String** | Asset symbol (XLM, BTC, ETH, USDC, USDT) | [required] |

### Return type

[**models::GetPriceByAsset200Response**](getPriceByAsset_200_response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_price_history

> models::GetPriceHistory200Response get_price_history(asset, cursor, from, to, limit)
Get historical prices for an asset

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**asset** | **String** | Asset symbol | [required] |
**cursor** | Option<**String**> | Opaque cursor from a previous response |  |
**from** | Option<**f64**> | Start timestamp (Unix seconds) |  |
**to** | Option<**f64**> | End timestamp (Unix seconds) |  |
**limit** | Option<**i32**> | Maximum number of records |  |[default to 100]

### Return type

[**models::GetPriceHistory200Response**](getPriceHistory_200_response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_prices

> models::GetPrices200Response get_prices(asset, page, limit)
Get all current prices

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**asset** | Option<**String**> | Filter by asset symbol (e.g. XLM, BTC) |  |
**page** | Option<**i32**> | Page number for offset pagination |  |[default to 1]
**limit** | Option<**i32**> | Items per page |  |[default to 20]

### Return type

[**models::GetPrices200Response**](getPrices_200_response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

