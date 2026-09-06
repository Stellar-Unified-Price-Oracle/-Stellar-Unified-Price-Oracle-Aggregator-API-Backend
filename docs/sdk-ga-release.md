# Client SDK GA release plan

The GA client release focuses on a stable contract surfaced by OpenAPI and version headers, and then materializing that contract into first-class language clients.

## SDK targets

- TypeScript
- Python
- Rust
- Go

## Release posture

- SDKs should be generated from the canonical API contract.
- Versioning must match the public API versioning policy.
- WebSocket and signing support should be treated as part of the GA contract instead of optional add-ons.

This keeps client adoption aligned with the API lifecycle and reduces version drift for downstream integrators.
