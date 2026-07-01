
# HealthCheck


## Properties

Name | Type
------------ | -------------
`service` | string
`status` | string
`uptime` | number
`timestamp` | number
`assetsTracked` | number

## Example

```typescript
import type { HealthCheck } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "service": stellar-price-oracle-api,
  "status": null,
  "uptime": 3600,
  "timestamp": 1719000000,
  "assetsTracked": 5,
} satisfies HealthCheck

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as HealthCheck
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


