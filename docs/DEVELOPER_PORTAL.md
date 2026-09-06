# Developer Portal GA

Closes #454.

## Goal

Provide a single, production-ready entry point for external integrators to discover the API, test flows against the sandbox, and move to first-call in the minimum time possible.

## Included in the portal

- Interactive API explorer served from `/api/v1/docs`
- A static developer workspace at `/portal` with key management, billing views, and onboarding shortcuts
- Example SDK links and code snippets for the most common price-fetching flows
- An embedded sandbox story for isolated integration testing before live usage

## Implementation notes

The API mounts the portal under `/portal`, and the static marketplace page lives under `docs/marketplace/` so the same content can be hosted alongside the API documentation. This keeps the developer experience centralized without creating a second service or app.

## GA checklist

- Hosted interactive docs and schema review
- Examples and SDK links for common client libraries
- Key creation, rotation, and usage visibility
- API playground access against the sandbox
- Clear pricing and usage guidance to reduce time-to-first-call

## Operations

- Keep the portal versioned with the API contract and release notes.
- Offer the portal in the same environment as the sandbox and production docs so developers can test before shipping.
- Validate that the portal is reachable from a clean browser session before each release.
