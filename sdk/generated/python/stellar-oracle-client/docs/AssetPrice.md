# AssetPrice


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**asset** | **str** |  | [optional] 
**price** | **str** |  | [optional] 
**decimals** | **int** |  | [optional] 
**source** | **str** |  | [optional] 
**timestamp** | **float** |  | [optional] 
**links** | [**Dict[str, HalLink]**](HalLink.md) | Map of relation name to hypermedia link (self, related, action links) | [optional] 

## Example

```python
from stellar-oracle-client.models.asset_price import AssetPrice

# TODO update the JSON string below
json = "{}"
# create an instance of AssetPrice from a JSON string
asset_price_instance = AssetPrice.from_json(json)
# print the JSON string representation of the object
print(AssetPrice.to_json())

# convert the object into a dict
asset_price_dict = asset_price_instance.to_dict()
# create an instance of AssetPrice from a dict
asset_price_from_dict = AssetPrice.from_dict(asset_price_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


