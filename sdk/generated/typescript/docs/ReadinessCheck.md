
# ReadinessCheck


## Properties

Name | Type
------------ | -------------
`status` | string
`assetsTracked` | number

## Example

```typescript
import type { ReadinessCheck } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "status": null,
  "assetsTracked": 5,
} satisfies ReadinessCheck

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as ReadinessCheck
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


