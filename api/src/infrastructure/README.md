# infrastructure/

This directory contains **adapter implementations** — concrete classes that
implement the domain ports defined in `domain/ports/`.

Adapters may freely import third-party libraries (pg, ioredis, axios, etc.)
and framework code (Express).  They must implement the port interface they
are named after exactly — the application layer only knows the interface, not
the adapter.

## Contents

| File | Purpose |
|------|---------|
| `PostgresPriceRepository.ts` | `IPriceRepository` backed by PostgreSQL |

## Dependency Rule

```
domain ← application ← infrastructure
```

Infrastructure imports from application and domain.  Domain never imports from
infrastructure.
