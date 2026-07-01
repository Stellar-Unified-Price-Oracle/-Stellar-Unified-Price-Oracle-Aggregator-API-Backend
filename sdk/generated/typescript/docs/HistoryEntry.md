
# HistoryEntry


## Properties

Name | Type
------------ | -------------
`price` | string
`decimals` | number
`source` | string
`timestamp` | number

## Example

```typescript
import type { HistoryEntry } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "price": null,
  "decimals": null,
  "source": null,
  "timestamp": null,
} satisfies HistoryEntry

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as HistoryEntry
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


