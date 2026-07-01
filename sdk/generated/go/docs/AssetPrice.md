# AssetPrice

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Asset** | Pointer to **string** |  | [optional] 
**Price** | Pointer to **string** |  | [optional] 
**Decimals** | Pointer to **int32** |  | [optional] 
**Source** | Pointer to **string** |  | [optional] 
**Timestamp** | Pointer to **float32** |  | [optional] 
**Links** | Pointer to [**map[string]HalLink**](HalLink.md) | Map of relation name to hypermedia link (self, related, action links) | [optional] 

## Methods

### NewAssetPrice

`func NewAssetPrice() *AssetPrice`

NewAssetPrice instantiates a new AssetPrice object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewAssetPriceWithDefaults

`func NewAssetPriceWithDefaults() *AssetPrice`

NewAssetPriceWithDefaults instantiates a new AssetPrice object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetAsset

`func (o *AssetPrice) GetAsset() string`

GetAsset returns the Asset field if non-nil, zero value otherwise.

### GetAssetOk

`func (o *AssetPrice) GetAssetOk() (*string, bool)`

GetAssetOk returns a tuple with the Asset field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAsset

`func (o *AssetPrice) SetAsset(v string)`

SetAsset sets Asset field to given value.

### HasAsset

`func (o *AssetPrice) HasAsset() bool`

HasAsset returns a boolean if a field has been set.

### GetPrice

`func (o *AssetPrice) GetPrice() string`

GetPrice returns the Price field if non-nil, zero value otherwise.

### GetPriceOk

`func (o *AssetPrice) GetPriceOk() (*string, bool)`

GetPriceOk returns a tuple with the Price field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPrice

`func (o *AssetPrice) SetPrice(v string)`

SetPrice sets Price field to given value.

### HasPrice

`func (o *AssetPrice) HasPrice() bool`

HasPrice returns a boolean if a field has been set.

### GetDecimals

`func (o *AssetPrice) GetDecimals() int32`

GetDecimals returns the Decimals field if non-nil, zero value otherwise.

### GetDecimalsOk

`func (o *AssetPrice) GetDecimalsOk() (*int32, bool)`

GetDecimalsOk returns a tuple with the Decimals field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetDecimals

`func (o *AssetPrice) SetDecimals(v int32)`

SetDecimals sets Decimals field to given value.

### HasDecimals

`func (o *AssetPrice) HasDecimals() bool`

HasDecimals returns a boolean if a field has been set.

### GetSource

`func (o *AssetPrice) GetSource() string`

GetSource returns the Source field if non-nil, zero value otherwise.

### GetSourceOk

`func (o *AssetPrice) GetSourceOk() (*string, bool)`

GetSourceOk returns a tuple with the Source field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSource

`func (o *AssetPrice) SetSource(v string)`

SetSource sets Source field to given value.

### HasSource

`func (o *AssetPrice) HasSource() bool`

HasSource returns a boolean if a field has been set.

### GetTimestamp

`func (o *AssetPrice) GetTimestamp() float32`

GetTimestamp returns the Timestamp field if non-nil, zero value otherwise.

### GetTimestampOk

`func (o *AssetPrice) GetTimestampOk() (*float32, bool)`

GetTimestampOk returns a tuple with the Timestamp field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetTimestamp

`func (o *AssetPrice) SetTimestamp(v float32)`

SetTimestamp sets Timestamp field to given value.

### HasTimestamp

`func (o *AssetPrice) HasTimestamp() bool`

HasTimestamp returns a boolean if a field has been set.

### GetLinks

`func (o *AssetPrice) GetLinks() map[string]HalLink`

GetLinks returns the Links field if non-nil, zero value otherwise.

### GetLinksOk

`func (o *AssetPrice) GetLinksOk() (*map[string]HalLink, bool)`

GetLinksOk returns a tuple with the Links field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLinks

`func (o *AssetPrice) SetLinks(v map[string]HalLink)`

SetLinks sets Links field to given value.

### HasLinks

`func (o *AssetPrice) HasLinks() bool`

HasLinks returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


