# GetPrices200ResponseData


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**timestamp** | **float** |  | [optional] 
**count** | **int** |  | [optional] 
**prices** | [**List[AssetPrice]**](AssetPrice.md) |  | [optional] 

## Example

```python
from stellar-oracle-client.models.get_prices200_response_data import GetPrices200ResponseData

# TODO update the JSON string below
json = "{}"
# create an instance of GetPrices200ResponseData from a JSON string
get_prices200_response_data_instance = GetPrices200ResponseData.from_json(json)
# print the JSON string representation of the object
print(GetPrices200ResponseData.to_json())

# convert the object into a dict
get_prices200_response_data_dict = get_prices200_response_data_instance.to_dict()
# create an instance of GetPrices200ResponseData from a dict
get_prices200_response_data_from_dict = GetPrices200ResponseData.from_dict(get_prices200_response_data_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


