
# WebhookRegistration


## Properties

Name | Type
------------ | -------------
`url` | string
`trigger` | [WebhookRegistrationTrigger](WebhookRegistrationTrigger.md)

## Example

```typescript
import type { WebhookRegistration } from '@stellar-oracle/sdk-typescript'

// TODO: Update the object below with actual values
const example = {
  "url": https://example.com/webhook,
  "trigger": null,
} satisfies WebhookRegistration

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as WebhookRegistration
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


