# OracleSource


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **str** |  | [optional] 
**active** | **bool** |  | [optional] 
**type** | **str** |  | [optional] 
**website** | **str** |  | [optional] 

## Example

```python
from stellar-oracle-client.models.oracle_source import OracleSource

# TODO update the JSON string below
json = "{}"
# create an instance of OracleSource from a JSON string
oracle_source_instance = OracleSource.from_json(json)
# print the JSON string representation of the object
print(OracleSource.to_json())

# convert the object into a dict
oracle_source_dict = oracle_source_instance.to_dict()
# create an instance of OracleSource from a dict
oracle_source_from_dict = OracleSource.from_dict(oracle_source_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


