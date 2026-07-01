# \PricesAPI

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**GetApiRoot**](PricesAPI.md#GetApiRoot) | **Get** /api/v1 | API root — list available endpoints
[**GetPriceByAsset**](PricesAPI.md#GetPriceByAsset) | **Get** /api/v1/prices/{asset} | Get current price for a specific asset
[**GetPriceHistory**](PricesAPI.md#GetPriceHistory) | **Get** /api/v1/history/{asset} | Get historical prices for an asset
[**GetPrices**](PricesAPI.md#GetPrices) | **Get** /api/v1/prices | Get all current prices



## GetApiRoot

> GetApiRoot(ctx).Execute()

API root — list available endpoints

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.PricesAPI.GetApiRoot(context.Background()).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `PricesAPI.GetApiRoot``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters

This endpoint does not need any parameter.

### Other Parameters

Other parameters are passed through a pointer to a apiGetApiRootRequest struct via the builder pattern


### Return type

 (empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## GetPriceByAsset

> GetPriceByAsset200Response GetPriceByAsset(ctx, asset).Execute()

Get current price for a specific asset

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	asset := "asset_example" // string | Asset symbol (XLM, BTC, ETH, USDC, USDT)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.PricesAPI.GetPriceByAsset(context.Background(), asset).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `PricesAPI.GetPriceByAsset``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `GetPriceByAsset`: GetPriceByAsset200Response
	fmt.Fprintf(os.Stdout, "Response from `PricesAPI.GetPriceByAsset`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**asset** | **string** | Asset symbol (XLM, BTC, ETH, USDC, USDT) | 

### Other Parameters

Other parameters are passed through a pointer to a apiGetPriceByAssetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**GetPriceByAsset200Response**](GetPriceByAsset200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## GetPriceHistory

> GetPriceHistory200Response GetPriceHistory(ctx, asset).Cursor(cursor).From(from).To(to).Limit(limit).Execute()

Get historical prices for an asset

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	asset := "asset_example" // string | Asset symbol
	cursor := "cursor_example" // string | Opaque cursor from a previous response (optional)
	from := float32(8.14) // float32 | Start timestamp (Unix seconds) (optional)
	to := float32(8.14) // float32 | End timestamp (Unix seconds) (optional)
	limit := int32(56) // int32 | Maximum number of records (optional) (default to 100)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.PricesAPI.GetPriceHistory(context.Background(), asset).Cursor(cursor).From(from).To(to).Limit(limit).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `PricesAPI.GetPriceHistory``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `GetPriceHistory`: GetPriceHistory200Response
	fmt.Fprintf(os.Stdout, "Response from `PricesAPI.GetPriceHistory`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**asset** | **string** | Asset symbol | 

### Other Parameters

Other parameters are passed through a pointer to a apiGetPriceHistoryRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **cursor** | **string** | Opaque cursor from a previous response | 
 **from** | **float32** | Start timestamp (Unix seconds) | 
 **to** | **float32** | End timestamp (Unix seconds) | 
 **limit** | **int32** | Maximum number of records | [default to 100]

### Return type

[**GetPriceHistory200Response**](GetPriceHistory200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## GetPrices

> GetPrices200Response GetPrices(ctx).Asset(asset).Page(page).Limit(limit).Execute()

Get all current prices

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	asset := "asset_example" // string | Filter by asset symbol (e.g. XLM, BTC) (optional)
	page := int32(56) // int32 | Page number for offset pagination (optional) (default to 1)
	limit := int32(56) // int32 | Items per page (optional) (default to 20)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.PricesAPI.GetPrices(context.Background()).Asset(asset).Page(page).Limit(limit).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `PricesAPI.GetPrices``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `GetPrices`: GetPrices200Response
	fmt.Fprintf(os.Stdout, "Response from `PricesAPI.GetPrices`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiGetPricesRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **asset** | **string** | Filter by asset symbol (e.g. XLM, BTC) | 
 **page** | **int32** | Page number for offset pagination | [default to 1]
 **limit** | **int32** | Items per page | [default to 20]

### Return type

[**GetPrices200Response**](GetPrices200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)

