
# GetPrices200ResponseData


## Properties

Name | Type
------------ | -------------
`timestamp` | number
`count` | number
`prices` | [Array&lt;AssetPrice&gt;](AssetPrice.md)

## Example

```typescript
import type { GetPrices200ResponseData } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "timestamp": null,
  "count": null,
  "prices": null,
} satisfies GetPrices200ResponseData

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GetPrices200ResponseData
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


