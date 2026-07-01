# stellar-oracle-client.WebhooksApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**api_v1_webhooks_get**](WebhooksApi.md#api_v1_webhooks_get) | **GET** /api/v1/webhooks | List registered webhooks
[**api_v1_webhooks_id_delete**](WebhooksApi.md#api_v1_webhooks_id_delete) | **DELETE** /api/v1/webhooks/{id} | Delete a webhook
[**api_v1_webhooks_id_deliveries_get**](WebhooksApi.md#api_v1_webhooks_id_deliveries_get) | **GET** /api/v1/webhooks/{id}/deliveries | Webhook delivery log
[**api_v1_webhooks_id_get**](WebhooksApi.md#api_v1_webhooks_id_get) | **GET** /api/v1/webhooks/{id} | Get a webhook
[**api_v1_webhooks_post**](WebhooksApi.md#api_v1_webhooks_post) | **POST** /api/v1/webhooks | Register a webhook


# **api_v1_webhooks_get**
> api_v1_webhooks_get()

List registered webhooks

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
    api_instance = stellar-oracle-client.WebhooksApi(api_client)

    try:
        # List registered webhooks
        api_instance.api_v1_webhooks_get()
    except Exception as e:
        print("Exception when calling WebhooksApi->api_v1_webhooks_get: %s\n" % e)
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
**200** | Webhook list |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **api_v1_webhooks_id_delete**
> api_v1_webhooks_id_delete()

Delete a webhook

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
    api_instance = stellar-oracle-client.WebhooksApi(api_client)

    try:
        # Delete a webhook
        api_instance.api_v1_webhooks_id_delete()
    except Exception as e:
        print("Exception when calling WebhooksApi->api_v1_webhooks_id_delete: %s\n" % e)
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
**204** | Deleted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **api_v1_webhooks_id_deliveries_get**
> api_v1_webhooks_id_deliveries_get()

Webhook delivery log

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
    api_instance = stellar-oracle-client.WebhooksApi(api_client)

    try:
        # Webhook delivery log
        api_instance.api_v1_webhooks_id_deliveries_get()
    except Exception as e:
        print("Exception when calling WebhooksApi->api_v1_webhooks_id_deliveries_get: %s\n" % e)
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
**200** | Delivery log entries |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **api_v1_webhooks_id_get**
> api_v1_webhooks_id_get()

Get a webhook

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
    api_instance = stellar-oracle-client.WebhooksApi(api_client)

    try:
        # Get a webhook
        api_instance.api_v1_webhooks_id_get()
    except Exception as e:
        print("Exception when calling WebhooksApi->api_v1_webhooks_id_get: %s\n" % e)
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
**200** | Webhook |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **api_v1_webhooks_post**
> api_v1_webhooks_post(webhook_registration=webhook_registration)

Register a webhook

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.webhook_registration import WebhookRegistration
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
    api_instance = stellar-oracle-client.WebhooksApi(api_client)
    webhook_registration = stellar-oracle-client.WebhookRegistration() # WebhookRegistration |  (optional)

    try:
        # Register a webhook
        api_instance.api_v1_webhooks_post(webhook_registration=webhook_registration)
    except Exception as e:
        print("Exception when calling WebhooksApi->api_v1_webhooks_post: %s\n" % e)
```



### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **webhook_registration** | [**WebhookRegistration**](WebhookRegistration.md)|  | [optional] 

### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**201** | Webhook created |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

