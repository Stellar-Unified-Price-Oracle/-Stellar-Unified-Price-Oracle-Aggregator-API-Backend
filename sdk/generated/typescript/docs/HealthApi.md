# HealthApi

All URIs are relative to *http://localhost:3000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getHealth**](HealthApi.md#gethealth) | **GET** /api/v1/health | Health check endpoint |
| [**getHealthLive**](HealthApi.md#gethealthlive) | **GET** /api/v1/health/live | Liveness probe |
| [**getHealthReady**](HealthApi.md#gethealthready) | **GET** /api/v1/health/ready | Readiness probe |



## getHealth

> GetHealth200Response getHealth()

Health check endpoint

### Example

```ts
import {
  Configuration,
  HealthApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetHealthRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new HealthApi();

  try {
    const data = await api.getHealth();
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

[**GetHealth200Response**](GetHealth200Response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Service health status |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getHealthLive

> LivenessCheck getHealthLive()

Liveness probe

### Example

```ts
import {
  Configuration,
  HealthApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetHealthLiveRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new HealthApi();

  try {
    const data = await api.getHealthLive();
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

[**LivenessCheck**](LivenessCheck.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Service is alive |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getHealthReady

> ReadinessCheck getHealthReady()

Readiness probe

### Example

```ts
import {
  Configuration,
  HealthApi,
} from '@stellar-oracle/sdk-typescript';
import type { GetHealthReadyRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new HealthApi();

  try {
    const data = await api.getHealthReady();
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

[**ReadinessCheck**](ReadinessCheck.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Service is ready |  -  |
| **503** | Service is not ready |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

