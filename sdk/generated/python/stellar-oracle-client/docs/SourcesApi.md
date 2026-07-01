# stellar-oracle-client.SourcesApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_sources**](SourcesApi.md#get_sources) | **GET** /api/v1/sources | List all oracle sources


# **get_sources**
> GetSources200Response get_sources(page=page, limit=limit)

List all oracle sources

### Example


```python
import stellar-oracle-client
from stellar-oracle-client.models.get_sources200_response import GetSources200Response
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
    api_instance = stellar-oracle-client.SourcesApi(api_client)
    page = 1 # int |  (optional) (default to 1)
    limit = 20 # int |  (optional) (default to 20)

    try:
        # List all oracle sources
        api_response = api_instance.get_sources(page=page, limit=limit)
        print("The response of SourcesApi->get_sources:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling SourcesApi->get_sources: %s\n" % e)
```



### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int**|  | [optional] [default to 1]
 **limit** | **int**|  | [optional] [default to 20]

### Return type

[**GetSources200Response**](GetSources200Response.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | Active oracle sources |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

