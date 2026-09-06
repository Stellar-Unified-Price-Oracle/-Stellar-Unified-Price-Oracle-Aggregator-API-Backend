# API contract freeze for v1

This contract aligns the documented API with the actual route surface and locks the stable v1 behavior before GA.

- v1 routes remain stable and are explicitly marked as deprecated in the runtime middleware.
- The OpenAPI document is reconciled with the shipped handlers in `api/src/infrastructure/openapi.ts`.
- The generated spec is intended to stay in sync with route registrations, and any route additions should be reflected here before release.

## Freeze scope

- `/api/v1` root endpoint
- `/api/v1/prices`
- `/api/v1/prices/{asset}`
- `/api/v1/history/{asset}`
- `/api/v1/sources`
- `/api/v1/health`, `/api/v1/health/live`, `/api/v1/health/ready`

This keeps the public contract stable for consumption while v2 is introduced as the current version.
