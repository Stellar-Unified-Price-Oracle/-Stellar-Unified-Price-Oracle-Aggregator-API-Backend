# LivenessCheck

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Status** | Pointer to **string** |  | [optional] 
**Uptime** | Pointer to **float32** |  | [optional] 

## Methods

### NewLivenessCheck

`func NewLivenessCheck() *LivenessCheck`

NewLivenessCheck instantiates a new LivenessCheck object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewLivenessCheckWithDefaults

`func NewLivenessCheckWithDefaults() *LivenessCheck`

NewLivenessCheckWithDefaults instantiates a new LivenessCheck object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetStatus

`func (o *LivenessCheck) GetStatus() string`

GetStatus returns the Status field if non-nil, zero value otherwise.

### GetStatusOk

`func (o *LivenessCheck) GetStatusOk() (*string, bool)`

GetStatusOk returns a tuple with the Status field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetStatus

`func (o *LivenessCheck) SetStatus(v string)`

SetStatus sets Status field to given value.

### HasStatus

`func (o *LivenessCheck) HasStatus() bool`

HasStatus returns a boolean if a field has been set.

### GetUptime

`func (o *LivenessCheck) GetUptime() float32`

GetUptime returns the Uptime field if non-nil, zero value otherwise.

### GetUptimeOk

`func (o *LivenessCheck) GetUptimeOk() (*float32, bool)`

GetUptimeOk returns a tuple with the Uptime field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetUptime

`func (o *LivenessCheck) SetUptime(v float32)`

SetUptime sets Uptime field to given value.

### HasUptime

`func (o *LivenessCheck) HasUptime() bool`

HasUptime returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


