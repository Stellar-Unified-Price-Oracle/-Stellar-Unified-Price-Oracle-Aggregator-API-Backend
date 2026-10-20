# ADR-0005: Governed feed catalog with per-feed eligibility, lifecycle and aliases

**Status:** Accepted

**Date:** 2026-10-19

**Issues:** #671, #672, #673, #674

---

## Context

The aggregator polls four oracle providers and publishes a median price per
asset. Three properties of that setup were implicit and therefore
unauditable:

1. **Asset identity.** A Stellar asset is identified by a bare ticker
   (`XLM`, `USDC`). `USDC` exists on more than one network and under more
   than one issuer, so the bare ticker is not a unique identifier. Two
   different assets could silently share one feed.

2. **Participation.** How many sources must report before a price is
   published, and which sources are allowed to contribute at all, was
   decided by global configuration rather than per feed. A feed that needs
   three sources to be trustworthy had no way to say so.

3. **Lifecycle and change.** There was no modelled path from "a feed was
   proposed" to "a feed is live" to "a feed was retired", and no record of
   who made that change and why. Renames and retirements were ad-hoc.

These are the "Feed catalog and lifecycle" workstream.

## Decision

Introduce a feed catalog in the API service, split into four composable
parts plus a service that holds the process-wide state.

### 1. Canonical asset identity (#671)

Every asset has a canonical id of the form `<network>:<CODE>:<ISSUER>`, with
`native` in place of the issuer for XLM. `resolveAssetAlias()` accepts the
canonical id, `CODE:ISSUER` in either order, a network-qualified native code,
a bare code resolved through the alias registry, and the bare native code.

Resolution is deterministic: a bare code that matches several issuers is
reported as `AMBIGUOUS` with the candidate ids, never silently resolved to an
arbitrary one. An unknown passphrase or malformed value is rejected rather
than guessed.

### 2. Per-feed eligibility and quorum (#674)

Each feed declares which sources are eligible and the quorum it must meet
(`minSources`, optionally `minWeightBps` and `distinctIssuersOnly`).
`validateFeedPolicy()` is the write-time gate; `evaluateQuorum()` is the
runtime check and returns the evidence for its verdict.

### 3. Governed onboarding lifecycle (#672)

`proposed -> validated -> canary -> active -> suspended -> retired`, with
`retired` terminal. Each transition is gated by both the current state and
the actor's role, requires a reason, and appends a `FeedChangeRecord` to the
feed's append-only change log. `activate` and `retire` require `admin`;
the remaining transitions require `operator`.

### 4. Alias and retirement semantics (#673)

Renamed, merged and retired feeds keep their old identifier working for a
bounded window. Each alias records a `sunsetAt` and a consumer-facing
`notice`. A merge must name a successor; a retirement must not. An expired
alias still resolves to its successor so a consumer is never silently pointed
at the wrong feed, but it is flagged `deprecated` and carries the removal
notice in the response metadata.

### Surface

A dedicated router at `/api/v1/catalog` (rather than inside the wider admin
router) so the catalog can be rolled back independently. RBAC uses two new
permissions, `feeds:read` and `feeds:write`.

Full design, monitoring and rollout/rollback guidance:
[`docs/FEED_CATALOG_LIFECYCLE.md`](../FEED_CATALOG_LIFECYCLE.md).

## Consequences

### Positive

- A feed's participation requirement is auditable from the catalog alone.
- Every lifecycle change has an owner, a role, a reason and a timestamp.
- Consumers are never silently redirected to a different asset.
- Renames and retirements have a bounded, declared compatibility window.

### Negative / Trade-offs

- The canonical asset id is longer than the bare ticker, so every consumer
  that stores asset identity has to be able to hold it.
- The catalog is in-process, so a feed registered on one replica is not
  known to another. The store abstraction is deliberately isolated in
  `feed-service.ts` so it can be backed by shared state later.
- A per-feed quorum is a second rule next to the global aggregator
  configuration, so operators must keep the two consistent.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep bare tickers and add the issuer to a separate field | The identity would still not be unique without the network, and the split representation invites partial comparisons. |
| Derive eligibility from source health at runtime | Health is a moving target; the *rule* must be explicit and auditable, not emergent. |
| Use the on-chain governance proposal flow for feed onboarding | Far too slow for a per-feed operational decision, and it cannot express a per-feed quorum. |
| Keep aliases forever | An unbounded compatibility shim is indistinguishable from a permanent API; a declared sunset is the only way to guarantee removal. |
