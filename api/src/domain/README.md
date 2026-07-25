# domain/

This directory contains the **pure domain model** — business entities, value
objects, domain events, and port interfaces.  Nothing in here may import from
`infrastructure/` or `application/`; it must remain framework-free and
dependency-free (only standard TypeScript / built-ins allowed).

## Contents

| File | Purpose |
|------|---------|
| `ports/` | Abstract interfaces (ports) that the domain exposes for external adapters to implement |
| `entities/` | Core business entities (e.g. `Price`, `OracleSource`) |
| `events/` | Domain events emitted when state changes |

## Hexagonal Architecture

```
         ┌───────────────────────────────┐
         │           Domain              │
         │  entities · value objects     │
         │  ports (interfaces)           │
         └──────────┬────────────────────┘
                    │
         ┌──────────▼────────────────────┐
         │         Application           │
         │  use-cases / services         │
         │  orchestrates domain          │
         └──────────┬────────────────────┘
                    │
         ┌──────────▼────────────────────┐
         │       Infrastructure          │
         │  adapters: HTTP, DB, cache    │
         │  implements domain ports      │
         └───────────────────────────────┘
```

The domain defines **what** (ports); infrastructure defines **how** (adapters).
