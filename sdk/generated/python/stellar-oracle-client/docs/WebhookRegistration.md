# WebhookRegistration


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**url** | **str** |  | [optional] 
**trigger** | [**WebhookRegistrationTrigger**](WebhookRegistrationTrigger.md) |  | [optional] 

## Example

```python
from stellar-oracle-client.models.webhook_registration import WebhookRegistration

# TODO update the JSON string below
json = "{}"
# create an instance of WebhookRegistration from a JSON string
webhook_registration_instance = WebhookRegistration.from_json(json)
# print the JSON string representation of the object
print(WebhookRegistration.to_json())

# convert the object into a dict
webhook_registration_dict = webhook_registration_instance.to_dict()
# create an instance of WebhookRegistration from a dict
webhook_registration_from_dict = WebhookRegistration.from_dict(webhook_registration_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


