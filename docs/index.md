# Stellar Unified Price Oracle — Documentation

Welcome to the Stellar Unified Price Oracle Aggregator API documentation.

## Quick links

- [API Reference](./api-reference/) — auto-generated TypeDoc documentation
- [API Guide](../api/docs/API.md) — REST + WebSocket protocol reference with auth, rate limiting, error codes, and examples
- [ADRs](./adr/) — Architecture Decision Records
- [Runbooks](./runbooks/) — operational runbooks
- [Observability](./observability/) — metrics cardinality & cost control, synthetic probes, public status page, on-chain event monitoring
- [Security Audit Plan](./SECURITY_AUDIT.md) — third-party Soroban contract audit scope and process
- [OpenAPI spec](../api/src/services/openapi.ts) — Swagger UI at `/api/v1/docs`
- [Threat Model](./THREAT_MODEL.md) — mainnet trust boundaries, attacker profiles, mitigations
- [Security Architecture](./SECURITY_ARCHITECTURE.md) — controls-level deep dive: SSRF protection, encryption at rest, API auth, WebSocket signing, sanitization, secrets management
- [Governance](./GOVERNANCE.md) — branch protection, signed commits, CODEOWNERS
- [Multi-Sig Administration & Operations](./MULTISIG_ADMINISTRATION.md) — signer setup, thresholds, proposal lifecycle, emergency procedures
- [Sandbox Security Review](./SANDBOX_SECURITY_REVIEW.md) — programmable feed / plugin sandbox review

## Architecture overview

The system is composed of three main services:

| Service | Purpose |
|---------|---------|
| `api/` | Express REST + WebSocket gateway, authentication, rate limiting |
| `services/aggregator/` | Price aggregation from multiple oracle sources |
| `services/vault_manager/` | Stellar vault / treasury management |

Key cross-cutting concerns: distributed tracing (OpenTelemetry), Prometheus
metrics, event sourcing (#118), feature flags (#117), and performance regression
detection in CI (#110).

## Getting started

```bash
# Install dependencies
cd api && npm ci

# Generate API reference docs
npm run docs:generate

# Start the development server
npm run dev
```
