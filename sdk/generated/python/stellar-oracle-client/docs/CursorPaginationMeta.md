# CursorPaginationMeta


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**limit** | **int** |  | [optional] 
**next_cursor** | **str** |  | [optional] 
**has_more** | **bool** |  | [optional] 

## Example

```python
from stellar-oracle-client.models.cursor_pagination_meta import CursorPaginationMeta

# TODO update the JSON string below
json = "{}"
# create an instance of CursorPaginationMeta from a JSON string
cursor_pagination_meta_instance = CursorPaginationMeta.from_json(json)
# print the JSON string representation of the object
print(CursorPaginationMeta.to_json())

# convert the object into a dict
cursor_pagination_meta_dict = cursor_pagination_meta_instance.to_dict()
# create an instance of CursorPaginationMeta from a dict
cursor_pagination_meta_from_dict = CursorPaginationMeta.from_dict(cursor_pagination_meta_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


