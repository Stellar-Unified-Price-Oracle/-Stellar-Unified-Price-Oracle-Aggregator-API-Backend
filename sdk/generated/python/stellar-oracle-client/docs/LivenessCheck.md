# LivenessCheck


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**status** | **str** |  | [optional] 
**uptime** | **float** |  | [optional] 

## Example

```python
from stellar-oracle-client.models.liveness_check import LivenessCheck

# TODO update the JSON string below
json = "{}"
# create an instance of LivenessCheck from a JSON string
liveness_check_instance = LivenessCheck.from_json(json)
# print the JSON string representation of the object
print(LivenessCheck.to_json())

# convert the object into a dict
liveness_check_dict = liveness_check_instance.to_dict()
# create an instance of LivenessCheck from a dict
liveness_check_from_dict = LivenessCheck.from_dict(liveness_check_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


