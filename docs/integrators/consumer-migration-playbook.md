# Consumer migration playbook

Owner: Developer ecosystem and integration. Scope: consumers moving between API
versions (v1 to v2) or adopting new feed metadata fields. See also
[api-versioning-policy](../api-versioning-policy.md).

## Compatibility windows

| Change type | Window | Signal |
| --- | --- | --- |
| New optional response field (additive) | None; ship anytime | Release notes |
| Deprecated endpoint or field | Until the `Sunset` date | `Deprecation`, `Sunset`, `Link rel="deprecation"` headers |
| Removed endpoint or field | Only after `Sunset` passes | `410`/`404` after sunset |

Consumers must ignore unknown fields so additive feed metadata never breaks them.

## Migration steps

1. **Inventory.** List every endpoint and field you read. Log `X-API-Version` and
   `Deprecation` response headers in your client to find deprecated calls.
2. **Pin.** Pin the version explicitly (`/api/v1/...` or `/api/v2/...`); never rely on defaults.
3. **Verify offline.** Replay the shared fixtures and run the conformance kit
   (the API contract checks) against the target version.
4. **Dual-read (shadow).** Call both versions, compare `asset`, `price`, `decimals`,
   `timestamp`; alert if relative price difference exceeds your tolerance.
5. **Canary.** Route a small percentage (for example 5%) of traffic to the new version.
6. **Cut over.** Raise to 100% once error rate and divergence stay flat for one full release cycle.
7. **Clean up.** Remove the old-version code path after the rollback window closes.

## Pre-flight checks (measurable completion evidence)

- Conformance kit exits 0 against the target environment.
- Zero responses with a `Deprecation` header in a 24h window.
- Shadow divergence below tolerance; error rate not above baseline.

## Boundary and failure cases

- **Unknown fields:** ignore, do not fail parsing.
- **Cursor pagination:** use `nextCursor`/`hasMore`; stop when `hasMore` is false or `nextCursor` is null.
- **Rate limited (429):** honour `Retry-After`; do not retry in a tight loop.
- **Error body:** `{ "code": string, "message": string }`; branch on `code`, never on `message`.
- **Price encoding:** `price` is a string integer scaled by `decimals`; never parse to float.

## Monitoring

Track per version: request count, 4xx/5xx rate, `Deprecation` header count, shadow
divergence, and p95 latency. Alert on any rise in deprecated-call count after cutover.

## Rollback

1. Flip the version flag/route weight back to the previous version (no deploy needed if the version is configuration).
2. Confirm traffic on the old version via `X-API-Version` and error rate recovery.
3. File an issue with the failing fixture or request id; do not re-attempt cutover until the conformance kit passes.

Rollback is only possible until the old version's `Sunset` date; schedule cutover
at least two weeks before it.

## Operational impact

Dual-read temporarily doubles read traffic for the shadowed endpoints; count it
against your rate-limit tier ([rate-limit-tiers](../rate-limit-tiers.md)).
