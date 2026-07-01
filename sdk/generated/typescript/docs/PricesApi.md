# PricesApi

All URIs are relative to *http://localhost:3000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getApiRoot**](PricesApi.md#getapiroot) | **GET** /api/v1 | API root — list available endpoints |
| [**getPriceByAsset**](PricesApi.md#getpricebyasset) | **GET** /api/v1/prices/{asset} | Get current price for a specific asset |
| [**getPriceHistory**](PricesApi.md#getpricehistory) | **GET** /api/v1/history/{asset} | Get historical prices for an asset |
| [**getPrices**](PricesApi.md#getprices) | **GET** /api/v1/prices | Get all current prices |



## getApiRoot

> getApiRoot()

API root — list available endpoints

### Example

```ts
import {
  Configuration,
  PricesApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetApiRootRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new PricesApi();

  try {
    const data = await api.getApiRoot();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

`void` (Empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Endpoint listing |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getPriceByAsset

> GetPriceByAsset200Response getPriceByAsset(asset)

Get current price for a specific asset

### Example

```ts
import {
  Configuration,
  PricesApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetPriceByAssetRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new PricesApi();

  const body = {
    // string | Asset symbol (XLM, BTC, ETH, USDC, USDT)
    asset: asset_example,
  } satisfies GetPriceByAssetRequest;

  try {
    const data = await api.getPriceByAsset(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **asset** | `string` | Asset symbol (XLM, BTC, ETH, USDC, USDT) | [Defaults to `undefined`] |

### Return type

[**GetPriceByAsset200Response**](GetPriceByAsset200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Price data for the requested asset |  -  |
| **404** | Asset not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getPriceHistory

> GetPriceHistory200Response getPriceHistory(asset, cursor, from, to, limit)

Get historical prices for an asset

### Example

```ts
import {
  Configuration,
  PricesApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetPriceHistoryRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new PricesApi();

  const body = {
    // string | Asset symbol
    asset: asset_example,
    // string | Opaque cursor from a previous response (optional)
    cursor: cursor_example,
    // number | Start timestamp (Unix seconds) (optional)
    from: 8.14,
    // number | End timestamp (Unix seconds) (optional)
    to: 8.14,
    // number | Maximum number of records (optional)
    limit: 56,
  } satisfies GetPriceHistoryRequest;

  try {
    const data = await api.getPriceHistory(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **asset** | `string` | Asset symbol | [Defaults to `undefined`] |
| **cursor** | `string` | Opaque cursor from a previous response | [Optional] [Defaults to `undefined`] |
| **from** | `number` | Start timestamp (Unix seconds) | [Optional] [Defaults to `undefined`] |
| **to** | `number` | End timestamp (Unix seconds) | [Optional] [Defaults to `undefined`] |
| **limit** | `number` | Maximum number of records | [Optional] [Defaults to `100`] |

### Return type

[**GetPriceHistory200Response**](GetPriceHistory200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Historical price data |  -  |
| **400** | Invalid parameters |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getPrices

> GetPrices200Response getPrices(asset, page, limit)

Get all current prices

### Example

```ts
import {
  Configuration,
  PricesApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetPricesRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new PricesApi();

  const body = {
    // string | Filter by asset symbol (e.g. XLM, BTC) (optional)
    asset: asset_example,
    // number | Page number for offset pagination (optional)
    page: 56,
    // number | Items per page (optional)
    limit: 56,
  } satisfies GetPricesRequest;

  try {
    const data = await api.getPrices(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **asset** | `string` | Filter by asset symbol (e.g. XLM, BTC) | [Optional] [Defaults to `undefined`] |
| **page** | `number` | Page number for offset pagination | [Optional] [Defaults to `1`] |
| **limit** | `number` | Items per page | [Optional] [Defaults to `20`] |

### Return type

[**GetPrices200Response**](GetPrices200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Array of current prices |  -  |
| **400** | Invalid query parameters |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

