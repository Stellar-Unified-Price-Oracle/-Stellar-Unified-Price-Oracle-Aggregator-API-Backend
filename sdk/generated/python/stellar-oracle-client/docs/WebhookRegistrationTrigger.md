# WebhookRegistrationTrigger


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**type** | **str** |  | [optional] 
**asset** | **str** |  | [optional] 
**value** | **float** |  | [optional] 

## Example

```python
from stellar-oracle-client.models.webhook_registration_trigger import WebhookRegistrationTrigger

# TODO update the JSON string below
json = "{}"
# create an instance of WebhookRegistrationTrigger from a JSON string
webhook_registration_trigger_instance = WebhookRegistrationTrigger.from_json(json)
# print the JSON string representation of the object
print(WebhookRegistrationTrigger.to_json())

# convert the object into a dict
webhook_registration_trigger_dict = webhook_registration_trigger_instance.to_dict()
# create an instance of WebhookRegistrationTrigger from a dict
webhook_registration_trigger_from_dict = WebhookRegistrationTrigger.from_dict(webhook_registration_trigger_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


