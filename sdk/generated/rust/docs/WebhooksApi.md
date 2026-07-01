# \WebhooksApi

All URIs are relative to *http://localhost:3000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**api_v1_webhooks_get**](WebhooksApi.md#api_v1_webhooks_get) | **GET** /api/v1/webhooks | List registered webhooks
[**api_v1_webhooks_id_delete**](WebhooksApi.md#api_v1_webhooks_id_delete) | **DELETE** /api/v1/webhooks/{id} | Delete a webhook
[**api_v1_webhooks_id_deliveries_get**](WebhooksApi.md#api_v1_webhooks_id_deliveries_get) | **GET** /api/v1/webhooks/{id}/deliveries | Webhook delivery log
[**api_v1_webhooks_id_get**](WebhooksApi.md#api_v1_webhooks_id_get) | **GET** /api/v1/webhooks/{id} | Get a webhook
[**api_v1_webhooks_post**](WebhooksApi.md#api_v1_webhooks_post) | **POST** /api/v1/webhooks | Register a webhook



## api_v1_webhooks_get

> api_v1_webhooks_get()
List registered webhooks

### Parameters

This endpoint does not need any parameter.

### Return type

 (empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## api_v1_webhooks_id_delete

> api_v1_webhooks_id_delete()
Delete a webhook

### Parameters

This endpoint does not need any parameter.

### Return type

 (empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## api_v1_webhooks_id_deliveries_get

> api_v1_webhooks_id_deliveries_get()
Webhook delivery log

### Parameters

This endpoint does not need any parameter.

### Return type

 (empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## api_v1_webhooks_id_get

> api_v1_webhooks_id_get()
Get a webhook

### Parameters

This endpoint does not need any parameter.

### Return type

 (empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## api_v1_webhooks_post

> api_v1_webhooks_post(webhook_registration)
Register a webhook

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**webhook_registration** | Option<[**WebhookRegistration**](WebhookRegistration.md)> |  |  |

### Return type

 (empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

