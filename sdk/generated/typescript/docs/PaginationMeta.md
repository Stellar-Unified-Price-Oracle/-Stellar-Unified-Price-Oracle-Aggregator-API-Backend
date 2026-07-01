
# PaginationMeta


## Properties

Name | Type
------------ | -------------
`page` | number
`limit` | number
`total` | number
`totalPages` | number
`hasNext` | boolean
`hasPrev` | boolean

## Example

```typescript
import type { PaginationMeta } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "page": null,
  "limit": null,
  "total": null,
  "totalPages": null,
  "hasNext": null,
  "hasPrev": null,
} satisfies PaginationMeta

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as PaginationMeta
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


