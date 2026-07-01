# HistoryData

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Asset** | Pointer to **string** |  | [optional] 
**To** | Pointer to **NullableFloat32** |  | [optional] 
**Prices** | Pointer to [**[]HistoryEntry**](HistoryEntry.md) |  | [optional] 
**Pagination** | Pointer to [**CursorPaginationMeta**](CursorPaginationMeta.md) |  | [optional] 

## Methods

### NewHistoryData

`func NewHistoryData() *HistoryData`

NewHistoryData instantiates a new HistoryData object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewHistoryDataWithDefaults

`func NewHistoryDataWithDefaults() *HistoryData`

NewHistoryDataWithDefaults instantiates a new HistoryData object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetAsset

`func (o *HistoryData) GetAsset() string`

GetAsset returns the Asset field if non-nil, zero value otherwise.

### GetAssetOk

`func (o *HistoryData) GetAssetOk() (*string, bool)`

GetAssetOk returns a tuple with the Asset field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAsset

`func (o *HistoryData) SetAsset(v string)`

SetAsset sets Asset field to given value.

### HasAsset

`func (o *HistoryData) HasAsset() bool`

HasAsset returns a boolean if a field has been set.

### GetTo

`func (o *HistoryData) GetTo() float32`

GetTo returns the To field if non-nil, zero value otherwise.

### GetToOk

`func (o *HistoryData) GetToOk() (*float32, bool)`

GetToOk returns a tuple with the To field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetTo

`func (o *HistoryData) SetTo(v float32)`

SetTo sets To field to given value.

### HasTo

`func (o *HistoryData) HasTo() bool`

HasTo returns a boolean if a field has been set.

### SetToNil

`func (o *HistoryData) SetToNil(b bool)`

 SetToNil sets the value for To to be an explicit nil

### UnsetTo
`func (o *HistoryData) UnsetTo()`

UnsetTo ensures that no value is present for To, not even an explicit nil
### GetPrices

`func (o *HistoryData) GetPrices() []HistoryEntry`

GetPrices returns the Prices field if non-nil, zero value otherwise.

### GetPricesOk

`func (o *HistoryData) GetPricesOk() (*[]HistoryEntry, bool)`

GetPricesOk returns a tuple with the Prices field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPrices

`func (o *HistoryData) SetPrices(v []HistoryEntry)`

SetPrices sets Prices field to given value.

### HasPrices

`func (o *HistoryData) HasPrices() bool`

HasPrices returns a boolean if a field has been set.

### GetPagination

`func (o *HistoryData) GetPagination() CursorPaginationMeta`

GetPagination returns the Pagination field if non-nil, zero value otherwise.

### GetPaginationOk

`func (o *HistoryData) GetPaginationOk() (*CursorPaginationMeta, bool)`

GetPaginationOk returns a tuple with the Pagination field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPagination

`func (o *HistoryData) SetPagination(v CursorPaginationMeta)`

SetPagination sets Pagination field to given value.

### HasPagination

`func (o *HistoryData) HasPagination() bool`

HasPagination returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


