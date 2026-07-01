# GetPrices200ResponseData

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Timestamp** | Pointer to **float32** |  | [optional] 
**Count** | Pointer to **int32** |  | [optional] 
**Prices** | Pointer to [**[]AssetPrice**](AssetPrice.md) |  | [optional] 

## Methods

### NewGetPrices200ResponseData

`func NewGetPrices200ResponseData() *GetPrices200ResponseData`

NewGetPrices200ResponseData instantiates a new GetPrices200ResponseData object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewGetPrices200ResponseDataWithDefaults

`func NewGetPrices200ResponseDataWithDefaults() *GetPrices200ResponseData`

NewGetPrices200ResponseDataWithDefaults instantiates a new GetPrices200ResponseData object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetTimestamp

`func (o *GetPrices200ResponseData) GetTimestamp() float32`

GetTimestamp returns the Timestamp field if non-nil, zero value otherwise.

### GetTimestampOk

`func (o *GetPrices200ResponseData) GetTimestampOk() (*float32, bool)`

GetTimestampOk returns a tuple with the Timestamp field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetTimestamp

`func (o *GetPrices200ResponseData) SetTimestamp(v float32)`

SetTimestamp sets Timestamp field to given value.

### HasTimestamp

`func (o *GetPrices200ResponseData) HasTimestamp() bool`

HasTimestamp returns a boolean if a field has been set.

### GetCount

`func (o *GetPrices200ResponseData) GetCount() int32`

GetCount returns the Count field if non-nil, zero value otherwise.

### GetCountOk

`func (o *GetPrices200ResponseData) GetCountOk() (*int32, bool)`

GetCountOk returns a tuple with the Count field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCount

`func (o *GetPrices200ResponseData) SetCount(v int32)`

SetCount sets Count field to given value.

### HasCount

`func (o *GetPrices200ResponseData) HasCount() bool`

HasCount returns a boolean if a field has been set.

### GetPrices

`func (o *GetPrices200ResponseData) GetPrices() []AssetPrice`

GetPrices returns the Prices field if non-nil, zero value otherwise.

### GetPricesOk

`func (o *GetPrices200ResponseData) GetPricesOk() (*[]AssetPrice, bool)`

GetPricesOk returns a tuple with the Prices field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPrices

`func (o *GetPrices200ResponseData) SetPrices(v []AssetPrice)`

SetPrices sets Prices field to given value.

### HasPrices

`func (o *GetPrices200ResponseData) HasPrices() bool`

HasPrices returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


