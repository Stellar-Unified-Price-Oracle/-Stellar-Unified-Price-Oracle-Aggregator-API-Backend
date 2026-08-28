# Programmable Feed & Plugin Sandbox — Security Review

Scope: `api/src/feeds/programmable-feeds.ts`, the DSL that backs user-defined
("programmable") feeds and the `wasm-plugin` aggregation strategy.

## Current implementation

As of this review, `programmable-feeds.ts` implements only the **declaration,
validation, gas-estimation, marketplace, and health-metering** layers of
programmable feeds. `validateFeedDefinition` requires a `wasmPluginId` when
`aggregation.strategy === 'wasm-plugin'`, but there is no WASM execution
runtime in this repository yet — no host that loads, instantiates, or invokes
plugin bytecode. Consequently there is currently **no attack surface** for
resource-exhaustion, memory-bound violation, or filesystem-escape attacks
against a plugin sandbox, because no plugin ever runs.

## Guarantees required before a plugin runtime ships

Before any WASM execution host is added, it must provide and be tested against:

- **CPU/time bounding**: a hard wall-clock and fuel/instruction-count limit per
  invocation (e.g. Wasmtime `fuel_consumed` metering), independent of the
  existing `timeoutMs` field on `FeedSourceDeclaration`, which only bounds
  network source fetches today.
- **Memory bounding**: a fixed linear-memory ceiling per plugin instance with
  no growth beyond it, enforced by the WASM engine's memory limiter, not by
  the plugin's own code.
- **No host filesystem/network access**: the plugin's import surface must be
  limited to pure computation (numeric aggregation inputs/outputs only) — no
  WASI filesystem, socket, or environment-variable imports linked in.
- **No cross-plugin state leakage**: each invocation gets a fresh instance;
  no shared linear memory or global state between tenants.

## Recommendation

Track the WASM execution host as separate implementation work; red-team it
(resource exhaustion, memory-bound, filesystem/network escape attempts) once
it exists, and add regression tests at that point covering each guarantee
above. Re-run this review whenever the plugin runtime is introduced.
