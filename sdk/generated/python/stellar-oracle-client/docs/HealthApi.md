# stellar-oracle-client.HealthApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_health**](HealthApi.md#get_health) | **GET** /api/v1/health | Health check endpoint
[**get_health_live**](HealthApi.md#get_health_live) | **GET** /api/v1/health/live | Liveness probe
[**get_health_ready**](HealthApi.md#get_health_ready) | **GET** /api/v1/health/ready | Readiness probe


# **get_health**
> GetHealth200Response get_health()

Health check endpoint

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.get_health200_response import GetHealth200Response
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
    api_instance = stellar-oracle-client.HealthApi(api_client)

    try:
        # Health check endpoint
        api_response = api_instance.get_health()
        print("The response of HealthApi->get_health:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling HealthApi->get_health: %s\n" % e)
```



### Parameters

This endpoint does not need any parameter.

### Return type

[**GetHealth200Response**](GetHealth200Response.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Service health status |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **get_health_live**
> LivenessCheck get_health_live()

Liveness probe

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.liveness_check import LivenessCheck
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
    api_instance = stellar-oracle-client.HealthApi(api_client)

    try:
        # Liveness probe
        api_response = api_instance.get_health_live()
        print("The response of HealthApi->get_health_live:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling HealthApi->get_health_live: %s\n" % e)
```



### Parameters

This endpoint does not need any parameter.

### Return type

[**LivenessCheck**](LivenessCheck.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Service is alive |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **get_health_ready**
> ReadinessCheck get_health_ready()

Readiness probe

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.readiness_check import ReadinessCheck
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
    api_instance = stellar-oracle-client.HealthApi(api_client)

    try:
        # Readiness probe
        api_response = api_instance.get_health_ready()
        print("The response of HealthApi->get_health_ready:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling HealthApi->get_health_ready: %s\n" % e)
```



### Parameters

This endpoint does not need any parameter.

### Return type

[**ReadinessCheck**](ReadinessCheck.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Service is ready |  -  |
**503** | Service is not ready |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

