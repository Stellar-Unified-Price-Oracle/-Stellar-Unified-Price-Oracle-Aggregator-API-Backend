# API versioning policy

The service supports a dual-version strategy where v2 is the current stable contract and v1 remains in maintenance mode.

## Policy

- `v2` is the current stable version.
- `v1` remains available for compatibility but is deprecated and carries deprecation headers on responses.
- The migration guide is the canonical source for consumers moving from v1 to v2.
- The sunset date is defined in the versioning middleware and should remain in sync with release notes and migration docs.

## Headers

v1 responses include the following:

- `Deprecation`
- `Sunset`
- `Link: <...>; rel="deprecation"`
- `X-API-Version: v1`

v2 responses include:

- `X-API-Version: v2`

This keeps the deprecation path explicit while preserving a clean upgrade path for integrators.
