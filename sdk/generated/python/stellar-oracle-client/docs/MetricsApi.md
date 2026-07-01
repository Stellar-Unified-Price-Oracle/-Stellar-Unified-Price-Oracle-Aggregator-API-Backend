# stellar-oracle-client.MetricsApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_metrics**](MetricsApi.md#get_metrics) | **GET** /metrics | Prometheus metrics endpoint


# **get_metrics**
> get_metrics()

Prometheus metrics endpoint

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
    api_instance = stellar-oracle-client.MetricsApi(api_client)

    try:
        # Prometheus metrics endpoint
        api_instance.get_metrics()
    except Exception as e:
        print("Exception when calling MetricsApi->get_metrics: %s\n" % e)
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
**200** | Prometheus text format metrics |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

