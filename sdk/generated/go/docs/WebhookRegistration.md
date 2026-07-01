# WebhookRegistration

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Url** | Pointer to **string** |  | [optional] 
**Trigger** | Pointer to [**WebhookRegistrationTrigger**](WebhookRegistrationTrigger.md) |  | [optional] 

## Methods

### NewWebhookRegistration

`func NewWebhookRegistration() *WebhookRegistration`

NewWebhookRegistration instantiates a new WebhookRegistration object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewWebhookRegistrationWithDefaults

`func NewWebhookRegistrationWithDefaults() *WebhookRegistration`

NewWebhookRegistrationWithDefaults instantiates a new WebhookRegistration object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetUrl

`func (o *WebhookRegistration) GetUrl() string`

GetUrl returns the Url field if non-nil, zero value otherwise.

### GetUrlOk

`func (o *WebhookRegistration) GetUrlOk() (*string, bool)`

GetUrlOk returns a tuple with the Url field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetUrl

`func (o *WebhookRegistration) SetUrl(v string)`

SetUrl sets Url field to given value.

### HasUrl

`func (o *WebhookRegistration) HasUrl() bool`

HasUrl returns a boolean if a field has been set.

### GetTrigger

`func (o *WebhookRegistration) GetTrigger() WebhookRegistrationTrigger`

GetTrigger returns the Trigger field if non-nil, zero value otherwise.

### GetTriggerOk

`func (o *WebhookRegistration) GetTriggerOk() (*WebhookRegistrationTrigger, bool)`

GetTriggerOk returns a tuple with the Trigger field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetTrigger

`func (o *WebhookRegistration) SetTrigger(v WebhookRegistrationTrigger)`

SetTrigger sets Trigger field to given value.

### HasTrigger

`func (o *WebhookRegistration) HasTrigger() bool`

HasTrigger returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


