
# OracleSource


## Properties

Name | Type
------------ | -------------
`name` | string
`active` | boolean
`type` | string
`website` | string

## Example

```typescript
import type { OracleSource } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "name": Chainlink,
  "active": true,
  "type": off-chain,
  "website": https://chain.link,
} satisfies OracleSource

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as OracleSource
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


