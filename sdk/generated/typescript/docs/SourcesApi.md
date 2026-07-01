# SourcesApi

All URIs are relative to *http://localhost:3000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getSources**](SourcesApi.md#getsources) | **GET** /api/v1/sources | List all oracle sources |



## getSources

> GetSources200Response getSources(page, limit)

List all oracle sources

### Example

```ts
import {
  Configuration,
  SourcesApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetSourcesRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new SourcesApi();

  const body = {
    // number (optional)
    page: 56,
    // number (optional)
    limit: 56,
  } satisfies GetSourcesRequest;

  try {
    const data = await api.getSources(body);
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
| **page** | `number` |  | [Optional] [Defaults to `1`] |
| **limit** | `number` |  | [Optional] [Defaults to `20`] |

### Return type

[**GetSources200Response**](GetSources200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Active oracle sources |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

