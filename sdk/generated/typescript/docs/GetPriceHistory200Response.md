
# GetPriceHistory200Response


## Properties

Name | Type
------------ | -------------
`success` | boolean
`data` | [HistoryData](HistoryData.md)
`cached` | boolean

## Example

```typescript
import type { GetPriceHistory200Response } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "success": null,
  "data": null,
  "cached": null,
} satisfies GetPriceHistory200Response

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GetPriceHistory200Response
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


