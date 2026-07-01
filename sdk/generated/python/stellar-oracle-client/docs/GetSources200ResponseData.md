# GetSources200ResponseData


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**sources** | [**List[OracleSource]**](OracleSource.md) |  | [optional] 

## Example

```python
from stellar-oracle-client.models.get_sources200_response_data import GetSources200ResponseData

# TODO update the JSON string below
json = "{}"
# create an instance of GetSources200ResponseData from a JSON string
get_sources200_response_data_instance = GetSources200ResponseData.from_json(json)
# print the JSON string representation of the object
print(GetSources200ResponseData.to_json())

# convert the object into a dict
get_sources200_response_data_dict = get_sources200_response_data_instance.to_dict()
# create an instance of GetSources200ResponseData from a dict
get_sources200_response_data_from_dict = GetSources200ResponseData.from_dict(get_sources200_response_data_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


