# MetricsApi

All URIs are relative to *http://localhost:3000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getMetrics**](MetricsApi.md#getmetrics) | **GET** /metrics | Prometheus metrics endpoint |



## getMetrics

> getMetrics()

Prometheus metrics endpoint

### Example

```ts
import {
  Configuration,
  MetricsApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetMetricsRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new MetricsApi();

  try {
    const data = await api.getMetrics();
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
| **200** | Prometheus text format metrics |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

