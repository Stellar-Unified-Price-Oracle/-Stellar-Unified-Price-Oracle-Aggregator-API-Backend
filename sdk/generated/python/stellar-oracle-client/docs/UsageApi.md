# stellar-oracle-client.UsageApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**api_v1_usage_anomalies_get**](UsageApi.md#api_v1_usage_anomalies_get) | **GET** /api/v1/usage/anomalies | Detected usage anomalies (request-volume spikes)
[**api_v1_usage_dashboard_get**](UsageApi.md#api_v1_usage_dashboard_get) | **GET** /api/v1/usage/dashboard | Usage dashboard (daily/weekly/monthly overview)
[**api_v1_usage_reports_get**](UsageApi.md#api_v1_usage_reports_get) | **GET** /api/v1/usage/reports | Usage report for a period


# **api_v1_usage_anomalies_get**
> api_v1_usage_anomalies_get()

Detected usage anomalies (request-volume spikes)

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
    api_instance = stellar-oracle-client.UsageApi(api_client)

    try:
        # Detected usage anomalies (request-volume spikes)
        api_instance.api_v1_usage_anomalies_get()
    except Exception as e:
        print("Exception when calling UsageApi->api_v1_usage_anomalies_get: %s\n" % e)
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
**200** | Anomaly list |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **api_v1_usage_dashboard_get**
> api_v1_usage_dashboard_get()

Usage dashboard (daily/weekly/monthly overview)

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
    api_instance = stellar-oracle-client.UsageApi(api_client)

    try:
        # Usage dashboard (daily/weekly/monthly overview)
        api_instance.api_v1_usage_dashboard_get()
    except Exception as e:
        print("Exception when calling UsageApi->api_v1_usage_dashboard_get: %s\n" % e)
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
**200** | Usage dashboard |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **api_v1_usage_reports_get**
> api_v1_usage_reports_get(period=period)

Usage report for a period

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
    api_instance = stellar-oracle-client.UsageApi(api_client)
    period = 'period_example' # str |  (optional)

    try:
        # Usage report for a period
        api_instance.api_v1_usage_reports_get(period=period)
    except Exception as e:
        print("Exception when calling UsageApi->api_v1_usage_reports_get: %s\n" % e)
```



### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **period** | **str**|  | [optional] 

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
**200** | Usage report |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

