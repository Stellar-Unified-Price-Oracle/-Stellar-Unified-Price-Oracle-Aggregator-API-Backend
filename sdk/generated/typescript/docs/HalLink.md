
# HalLink


## Properties

Name | Type
------------ | -------------
`href` | string
`method` | string
`title` | string

## Example

```typescript
import type { HalLink } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "href": /api/v1/prices/XLM,
  "method": GET,
  "title": null,
} satisfies HalLink

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as HalLink
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


