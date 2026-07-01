# stellar-oracle-client.PricesApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_api_root**](PricesApi.md#get_api_root) | **GET** /api/v1 | API root — list available endpoints
[**get_price_by_asset**](PricesApi.md#get_price_by_asset) | **GET** /api/v1/prices/{asset} | Get current price for a specific asset
[**get_price_history**](PricesApi.md#get_price_history) | **GET** /api/v1/history/{asset} | Get historical prices for an asset
[**get_prices**](PricesApi.md#get_prices) | **GET** /api/v1/prices | Get all current prices


# **get_api_root**
> get_api_root()

API root — list available endpoints

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.rest import ApiException
from pprint import pprint

# Defining the host is optional and defaults to http://localhost:3000
# See configuration.py for a list of all supported configuration parameters.
configuration = stellar-oracle-client.Configuration(
    host = "http://localhost:3000"
)


# Enter a context with an instance of the API client
with stellar-oracle-client.ApiClient(configuration) as api_client:
    # Create an instance of the API class
    api_instance = stellar-oracle-client.PricesApi(api_client)

    try:
        # API root — list available endpoints
        api_instance.get_api_root()
    except Exception as e:
        print("Exception when calling PricesApi->get_api_root: %s\n" % e)
```



### Parameters

This endpoint does not need any parameter.

### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Endpoint listing |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **get_price_by_asset**
> GetPriceByAsset200Response get_price_by_asset(asset)

Get current price for a specific asset

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.get_price_by_asset200_response import GetPriceByAsset200Response
from stellar-oracle-client.rest import ApiException
from pprint import pprint

# Defining the host is optional and defaults to http://localhost:3000
# See configuration.py for a list of all supported configuration parameters.
configuration = stellar-oracle-client.Configuration(
    host = "http://localhost:3000"
)


# Enter a context with an instance of the API client
with stellar-oracle-client.ApiClient(configuration) as api_client:
    # Create an instance of the API class
    api_instance = stellar-oracle-client.PricesApi(api_client)
    asset = 'asset_example' # str | Asset symbol (XLM, BTC, ETH, USDC, USDT)

    try:
        # Get current price for a specific asset
        api_response = api_instance.get_price_by_asset(asset)
        print("The response of PricesApi->get_price_by_asset:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling PricesApi->get_price_by_asset: %s\n" % e)
```



### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **asset** | **str**| Asset symbol (XLM, BTC, ETH, USDC, USDT) | 

### Return type

[**GetPriceByAsset200Response**](GetPriceByAsset200Response.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Price data for the requested asset |  -  |
**404** | Asset not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **get_price_history**
> GetPriceHistory200Response get_price_history(asset, cursor=cursor, var_from=var_from, to=to, limit=limit)

Get historical prices for an asset

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.get_price_history200_response import GetPriceHistory200Response
from stellar-oracle-client.rest import ApiException
from pprint import pprint

# Defining the host is optional and defaults to http://localhost:3000
# See configuration.py for a list of all supported configuration parameters.
configuration = stellar-oracle-client.Configuration(
    host = "http://localhost:3000"
)


# Enter a context with an instance of the API client
with stellar-oracle-client.ApiClient(configuration) as api_client:
    # Create an instance of the API class
    api_instance = stellar-oracle-client.PricesApi(api_client)
    asset = 'asset_example' # str | Asset symbol
    cursor = 'cursor_example' # str | Opaque cursor from a previous response (optional)
    var_from = 3.4 # float | Start timestamp (Unix seconds) (optional)
    to = 3.4 # float | End timestamp (Unix seconds) (optional)
    limit = 100 # int | Maximum number of records (optional) (default to 100)

    try:
        # Get historical prices for an asset
        api_response = api_instance.get_price_history(asset, cursor=cursor, var_from=var_from, to=to, limit=limit)
        print("The response of PricesApi->get_price_history:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling PricesApi->get_price_history: %s\n" % e)
```



### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **asset** | **str**| Asset symbol | 
 **cursor** | **str**| Opaque cursor from a previous response | [optional] 
 **var_from** | **float**| Start timestamp (Unix seconds) | [optional] 
 **to** | **float**| End timestamp (Unix seconds) | [optional] 
 **limit** | **int**| Maximum number of records | [optional] [default to 100]

### Return type

[**GetPriceHistory200Response**](GetPriceHistory200Response.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Historical price data |  -  |
**400** | Invalid parameters |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **get_prices**
> GetPrices200Response get_prices(asset=asset, page=page, limit=limit)

Get all current prices

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.get_prices200_response import GetPrices200Response
from stellar-oracle-client.rest import ApiException
from pprint import pprint

# Defining the host is optional and defaults to http://localhost:3000
# See configuration.py for a list of all supported configuration parameters.
configuration = stellar-oracle-client.Configuration(
    host = "http://localhost:3000"
)


# Enter a context with an instance of the API client
with stellar-oracle-client.ApiClient(configuration) as api_client:
    # Create an instance of the API class
    api_instance = stellar-oracle-client.PricesApi(api_client)
    asset = 'asset_example' # str | Filter by asset symbol (e.g. XLM, BTC) (optional)
    page = 1 # int | Page number for offset pagination (optional) (default to 1)
    limit = 20 # int | Items per page (optional) (default to 20)

    try:
        # Get all current prices
        api_response = api_instance.get_prices(asset=asset, page=page, limit=limit)
        print("The response of PricesApi->get_prices:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling PricesApi->get_prices: %s\n" % e)
```



### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **asset** | **str**| Filter by asset symbol (e.g. XLM, BTC) | [optional] 
 **page** | **int**| Page number for offset pagination | [optional] [default to 1]
 **limit** | **int**| Items per page | [optional] [default to 20]

### Return type

[**GetPrices200Response**](GetPrices200Response.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Array of current prices |  -  |
**400** | Invalid query parameters |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

