# GetPriceHistory200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**success** | **bool** |  | [optional] 
**data** | [**HistoryData**](HistoryData.md) |  | [optional] 
**cached** | **bool** |  | [optional] 

## Example

```python
from stellar-oracle-client.models.get_price_history200_response import GetPriceHistory200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetPriceHistory200Response from a JSON string
get_price_history200_response_instance = GetPriceHistory200Response.from_json(json)
# print the JSON string representation of the object
print(GetPriceHistory200Response.to_json())

# convert the object into a dict
get_price_history200_response_dict = get_price_history200_response_instance.to_dict()
# create an instance of GetPriceHistory200Response from a dict
get_price_history200_response_from_dict = GetPriceHistory200Response.from_dict(get_price_history200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


