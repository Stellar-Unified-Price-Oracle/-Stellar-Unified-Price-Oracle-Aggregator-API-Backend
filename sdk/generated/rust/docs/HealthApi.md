# \HealthApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_health**](HealthApi.md#get_health) | **GET** /api/v1/health | Health check endpoint
[**get_health_live**](HealthApi.md#get_health_live) | **GET** /api/v1/health/live | Liveness probe
[**get_health_ready**](HealthApi.md#get_health_ready) | **GET** /api/v1/health/ready | Readiness probe



## get_health

> models::GetHealth200Response get_health()
Health check endpoint

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::GetHealth200Response**](getHealth_200_response.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_health_live

> models::LivenessCheck get_health_live()
Liveness probe

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::LivenessCheck**](LivenessCheck.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_health_ready

> models::ReadinessCheck get_health_ready()
Readiness probe

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::ReadinessCheck**](ReadinessCheck.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

