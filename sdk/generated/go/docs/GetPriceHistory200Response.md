# GetPriceHistory200Response

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Success** | Pointer to **bool** |  | [optional] 
**Data** | Pointer to [**HistoryData**](HistoryData.md) |  | [optional] 
**Cached** | Pointer to **bool** |  | [optional] 

## Methods

### NewGetPriceHistory200Response

`func NewGetPriceHistory200Response() *GetPriceHistory200Response`

NewGetPriceHistory200Response instantiates a new GetPriceHistory200Response object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewGetPriceHistory200ResponseWithDefaults

`func NewGetPriceHistory200ResponseWithDefaults() *GetPriceHistory200Response`

NewGetPriceHistory200ResponseWithDefaults instantiates a new GetPriceHistory200Response object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetSuccess

`func (o *GetPriceHistory200Response) GetSuccess() bool`

GetSuccess returns the Success field if non-nil, zero value otherwise.

### GetSuccessOk

`func (o *GetPriceHistory200Response) GetSuccessOk() (*bool, bool)`

GetSuccessOk returns a tuple with the Success field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSuccess

`func (o *GetPriceHistory200Response) SetSuccess(v bool)`

SetSuccess sets Success field to given value.

### HasSuccess

`func (o *GetPriceHistory200Response) HasSuccess() bool`

HasSuccess returns a boolean if a field has been set.

### GetData

`func (o *GetPriceHistory200Response) GetData() HistoryData`

GetData returns the Data field if non-nil, zero value otherwise.

### GetDataOk

`func (o *GetPriceHistory200Response) GetDataOk() (*HistoryData, bool)`

GetDataOk returns a tuple with the Data field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetData

`func (o *GetPriceHistory200Response) SetData(v HistoryData)`

SetData sets Data field to given value.

### HasData

`func (o *GetPriceHistory200Response) HasData() bool`

HasData returns a boolean if a field has been set.

### GetCached

`func (o *GetPriceHistory200Response) GetCached() bool`

GetCached returns the Cached field if non-nil, zero value otherwise.

### GetCachedOk

`func (o *GetPriceHistory200Response) GetCachedOk() (*bool, bool)`

GetCachedOk returns a tuple with the Cached field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCached

`func (o *GetPriceHistory200Response) SetCached(v bool)`

SetCached sets Cached field to given value.

### HasCached

`func (o *GetPriceHistory200Response) HasCached() bool`

HasCached returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


