
# AssetPrice


## Properties

Name | Type
------------ | -------------
`asset` | string
`price` | string
`decimals` | number
`source` | string
`timestamp` | number
`links` | [{ [key: string]: HalLink; }](HalLink.md)

## Example

```typescript
import type { AssetPrice } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "asset": XLM,
  "price": 10000000000,
  "decimals": 7,
  "source": chainlink,
  "timestamp": 1719000000,
  "links": null,
} satisfies AssetPrice

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as AssetPrice
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


