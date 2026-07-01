# UsageApi

All URIs are relative to *http://localhost:3000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**apiV1UsageAnomaliesGet**](UsageApi.md#apiv1usageanomaliesget) | **GET** /api/v1/usage/anomalies | Detected usage anomalies (request-volume spikes) |
| [**apiV1UsageDashboardGet**](UsageApi.md#apiv1usagedashboardget) | **GET** /api/v1/usage/dashboard | Usage dashboard (daily/weekly/monthly overview) |
| [**apiV1UsageReportsGet**](UsageApi.md#apiv1usagereportsget) | **GET** /api/v1/usage/reports | Usage report for a period |



## apiV1UsageAnomaliesGet

> apiV1UsageAnomaliesGet()

Detected usage anomalies (request-volume spikes)

### Example

```ts
import {
  Configuration,
  UsageApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1UsageAnomaliesGetRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new UsageApi();

  try {
    const data = await api.apiV1UsageAnomaliesGet();
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
| **200** | Anomaly list |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## apiV1UsageDashboardGet

> apiV1UsageDashboardGet()

Usage dashboard (daily/weekly/monthly overview)

### Example

```ts
import {
  Configuration,
  UsageApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1UsageDashboardGetRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new UsageApi();

  try {
    const data = await api.apiV1UsageDashboardGet();
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
| **200** | Usage dashboard |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## apiV1UsageReportsGet

> apiV1UsageReportsGet(period)

Usage report for a period

### Example

```ts
import {
  Configuration,
  UsageApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1UsageReportsGetRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new UsageApi();

  const body = {
    // 'daily' | 'weekly' | 'monthly' (optional)
    period: period_example,
  } satisfies ApiV1UsageReportsGetRequest;

  try {
    const data = await api.apiV1UsageReportsGet(body);
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
| **period** | `daily`, `weekly`, `monthly` |  | [Optional] [Defaults to `undefined`] [Enum: daily, weekly, monthly] |

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
| **200** | Usage report |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

