# GetSources200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**success** | **bool** |  | [optional] 
**data** | [**GetSources200ResponseData**](GetSources200ResponseData.md) |  | [optional] 

## Example

```python
from stellar-oracle-client.models.get_sources200_response import GetSources200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetSources200Response from a JSON string
get_sources200_response_instance = GetSources200Response.from_json(json)
# print the JSON string representation of the object
print(GetSources200Response.to_json())

# convert the object into a dict
get_sources200_response_dict = get_sources200_response_instance.to_dict()
# create an instance of GetSources200Response from a dict
get_sources200_response_from_dict = GetSources200Response.from_dict(get_sources200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


