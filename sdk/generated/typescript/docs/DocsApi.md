# DocsApi

All URIs are relative to *http://localhost:3000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getDocs**](DocsApi.md#getdocs) | **GET** /api/v1/docs | Swagger UI documentation |



## getDocs

> getDocs()

Swagger UI documentation

### Example

```ts
import {
  Configuration,
  DocsApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetDocsRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new DocsApi();

  try {
    const data = await api.getDocs();
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
| **200** | Swagger UI HTML page |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

