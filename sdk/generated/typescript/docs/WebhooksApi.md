# WebhooksApi

All URIs are relative to *http://localhost:3000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**apiV1WebhooksGet**](WebhooksApi.md#apiv1webhooksget) | **GET** /api/v1/webhooks | List registered webhooks |
| [**apiV1WebhooksIdDelete**](WebhooksApi.md#apiv1webhooksiddelete) | **DELETE** /api/v1/webhooks/{id} | Delete a webhook |
| [**apiV1WebhooksIdDeliveriesGet**](WebhooksApi.md#apiv1webhooksiddeliveriesget) | **GET** /api/v1/webhooks/{id}/deliveries | Webhook delivery log |
| [**apiV1WebhooksIdGet**](WebhooksApi.md#apiv1webhooksidget) | **GET** /api/v1/webhooks/{id} | Get a webhook |
| [**apiV1WebhooksPost**](WebhooksApi.md#apiv1webhookspost) | **POST** /api/v1/webhooks | Register a webhook |



## apiV1WebhooksGet

> apiV1WebhooksGet()

List registered webhooks

### Example

```ts
import {
  Configuration,
  WebhooksApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1WebhooksGetRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new WebhooksApi();

  try {
    const data = await api.apiV1WebhooksGet();
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
| **200** | Webhook list |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## apiV1WebhooksIdDelete

> apiV1WebhooksIdDelete()

Delete a webhook

### Example

```ts
import {
  Configuration,
  WebhooksApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1WebhooksIdDeleteRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new WebhooksApi();

  try {
    const data = await api.apiV1WebhooksIdDelete();
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
| **204** | Deleted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## apiV1WebhooksIdDeliveriesGet

> apiV1WebhooksIdDeliveriesGet()

Webhook delivery log

### Example

```ts
import {
  Configuration,
  WebhooksApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1WebhooksIdDeliveriesGetRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new WebhooksApi();

  try {
    const data = await api.apiV1WebhooksIdDeliveriesGet();
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
| **200** | Delivery log entries |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## apiV1WebhooksIdGet

> apiV1WebhooksIdGet()

Get a webhook

### Example

```ts
import {
  Configuration,
  WebhooksApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1WebhooksIdGetRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new WebhooksApi();

  try {
    const data = await api.apiV1WebhooksIdGet();
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
| **200** | Webhook |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## apiV1WebhooksPost

> apiV1WebhooksPost(webhookRegistration)

Register a webhook

### Example

```ts
import {
  Configuration,
  WebhooksApi,
} from '@stellar-oracle/sdk-typescript';
import type { ApiV1WebhooksPostRequest } from '@stellar-oracle/sdk-typescript';

async function example() {
  console.log("🚀 Testing @stellar-oracle/sdk-typescript SDK...");
  const api = new WebhooksApi();

  const body = {
    // WebhookRegistration (optional)
    webhookRegistration: ...,
  } satisfies ApiV1WebhooksPostRequest;

  try {
    const data = await api.apiV1WebhooksPost(body);
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
| **webhookRegistration** | [WebhookRegistration](WebhookRegistration.md) |  | [Optional] |

### Return type

`void` (Empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | Webhook created |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

