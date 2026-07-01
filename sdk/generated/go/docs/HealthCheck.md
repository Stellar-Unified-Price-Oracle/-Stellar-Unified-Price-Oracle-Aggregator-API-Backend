# HealthCheck

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Service** | Pointer to **string** |  | [optional] 
**Status** | Pointer to **string** |  | [optional] 
**Uptime** | Pointer to **float32** |  | [optional] 
**Timestamp** | Pointer to **float32** |  | [optional] 
**AssetsTracked** | Pointer to **int32** |  | [optional] 

## Methods

### NewHealthCheck

`func NewHealthCheck() *HealthCheck`

NewHealthCheck instantiates a new HealthCheck object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewHealthCheckWithDefaults

`func NewHealthCheckWithDefaults() *HealthCheck`

NewHealthCheckWithDefaults instantiates a new HealthCheck object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetService

`func (o *HealthCheck) GetService() string`

GetService returns the Service field if non-nil, zero value otherwise.

### GetServiceOk

`func (o *HealthCheck) GetServiceOk() (*string, bool)`

GetServiceOk returns a tuple with the Service field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetService

`func (o *HealthCheck) SetService(v string)`

SetService sets Service field to given value.

### HasService

`func (o *HealthCheck) HasService() bool`

HasService returns a boolean if a field has been set.

### GetStatus

`func (o *HealthCheck) GetStatus() string`

GetStatus returns the Status field if non-nil, zero value otherwise.

### GetStatusOk

`func (o *HealthCheck) GetStatusOk() (*string, bool)`

GetStatusOk returns a tuple with the Status field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetStatus

`func (o *HealthCheck) SetStatus(v string)`

SetStatus sets Status field to given value.

### HasStatus

`func (o *HealthCheck) HasStatus() bool`

HasStatus returns a boolean if a field has been set.

### GetUptime

`func (o *HealthCheck) GetUptime() float32`

GetUptime returns the Uptime field if non-nil, zero value otherwise.

### GetUptimeOk

`func (o *HealthCheck) GetUptimeOk() (*float32, bool)`

GetUptimeOk returns a tuple with the Uptime field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetUptime

`func (o *HealthCheck) SetUptime(v float32)`

SetUptime sets Uptime field to given value.

### HasUptime

`func (o *HealthCheck) HasUptime() bool`

HasUptime returns a boolean if a field has been set.

### GetTimestamp

`func (o *HealthCheck) GetTimestamp() float32`

GetTimestamp returns the Timestamp field if non-nil, zero value otherwise.

### GetTimestampOk

`func (o *HealthCheck) GetTimestampOk() (*float32, bool)`

GetTimestampOk returns a tuple with the Timestamp field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetTimestamp

`func (o *HealthCheck) SetTimestamp(v float32)`

SetTimestamp sets Timestamp field to given value.

### HasTimestamp

`func (o *HealthCheck) HasTimestamp() bool`

HasTimestamp returns a boolean if a field has been set.

### GetAssetsTracked

`func (o *HealthCheck) GetAssetsTracked() int32`

GetAssetsTracked returns the AssetsTracked field if non-nil, zero value otherwise.

### GetAssetsTrackedOk

`func (o *HealthCheck) GetAssetsTrackedOk() (*int32, bool)`

GetAssetsTrackedOk returns a tuple with the AssetsTracked field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAssetsTracked

`func (o *HealthCheck) SetAssetsTracked(v int32)`

SetAssetsTracked sets AssetsTracked field to given value.

### HasAssetsTracked

`func (o *HealthCheck) HasAssetsTracked() bool`

HasAssetsTracked returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


