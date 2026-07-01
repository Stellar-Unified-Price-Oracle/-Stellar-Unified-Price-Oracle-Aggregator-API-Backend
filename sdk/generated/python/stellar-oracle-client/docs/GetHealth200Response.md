# GetHealth200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**success** | **bool** |  | [optional] 
**data** | [**HealthCheck**](HealthCheck.md) |  | [optional] 

## Example

```python
from stellar-oracle-client.models.get_health200_response import GetHealth200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetHealth200Response from a JSON string
get_health200_response_instance = GetHealth200Response.from_json(json)
# print the JSON string representation of the object
print(GetHealth200Response.to_json())

# convert the object into a dict
get_health200_response_dict = get_health200_response_instance.to_dict()
# create an instance of GetHealth200Response from a dict
get_health200_response_from_dict = GetHealth200Response.from_dict(get_health200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


