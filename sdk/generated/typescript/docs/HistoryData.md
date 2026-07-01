
# HistoryData


## Properties

Name | Type
------------ | -------------
`asset` | string
`to` | number
`prices` | [Array&lt;HistoryEntry&gt;](HistoryEntry.md)
`pagination` | [CursorPaginationMeta](CursorPaginationMeta.md)

## Example

```typescript
import type { HistoryData } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "asset": null,
  "to": null,
  "prices": null,
  "pagination": null,
} satisfies HistoryData

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as HistoryData
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


