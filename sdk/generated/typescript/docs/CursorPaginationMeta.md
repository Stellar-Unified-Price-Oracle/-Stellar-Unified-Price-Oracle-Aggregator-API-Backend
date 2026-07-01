
# CursorPaginationMeta


## Properties

Name | Type
------------ | -------------
`limit` | number
`nextCursor` | string
`hasMore` | boolean

## Example

```typescript
import type { CursorPaginationMeta } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "limit": null,
  "nextCursor": null,
  "hasMore": null,
} satisfies CursorPaginationMeta

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as CursorPaginationMeta
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


