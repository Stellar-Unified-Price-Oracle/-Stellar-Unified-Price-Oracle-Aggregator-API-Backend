# API Deprecation Policy

## Overview

This document defines how the Stellar Unified Price Oracle & Aggregator API
communicates deprecations to consumers and the minimum timeline before a
deprecated endpoint or field is removed.

## Timeline

- **Announcement**: deprecations are announced at least **90 days** before
  removal via the `Deprecation` HTTP header, response body warnings, and the
  notification system (changelog + webhook subscribers).
- **Sunset**: the `Sunset` HTTP header carries the exact removal date (RFC
  8594). After this date the endpoint returns `410 Gone`.
- **Removal**: the endpoint is removed from the codebase and OpenAPI spec
  only after the sunset date has passed.

## Headers

| Header | Description |
| --- | --- |
| `Deprecation: date="<RFC 3339 date>"` | Marks the response as coming from a deprecated endpoint, and when it was deprecated. |
| `Sunset: <RFC 7231 HTTP date>` | The date the endpoint will stop functioning. |
| `Link: <url>; rel="deprecation"` | Optional link to migration documentation. |

## Response body

Deprecated endpoints additionally include a `deprecation` object in JSON
responses:

```json
{
  "data": { "...": "..." },
  "deprecation": {
    "deprecated": true,
    "message": "This endpoint is deprecated and will be removed on 2026-12-31.",
    "sunset": "2026-12-31"
  }
}
```

## Notification system

`api/src/services/deprecation-notifier.ts` tracks unique API keys that hit a
deprecated endpoint and emits events that can be subscribed to (logs today;
webhook/email delivery can subscribe via `onDeprecatedUsage` without further
changes to route code) so affected consumers can be proactively notified
ahead of the sunset date.

## Marking an endpoint deprecated

```ts
import { deprecate } from '../middleware/deprecation';

router.get(
  '/legacy-endpoint',
  deprecate({
    deprecatedOn: '2026-06-30',
    sunsetOn: '2026-09-30',
    link: 'https://docs.example.com/migration/legacy-endpoint',
  }),
  handler,
);
```
