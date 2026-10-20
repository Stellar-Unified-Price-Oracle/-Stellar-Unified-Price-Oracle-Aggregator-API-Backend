# Region-scoped provider configuration (issue #685)

**Owner:** provider ecosystem workstream · **Scope:** aggregator config
**Evidence:** `npm test` — `services/aggregator/tests/region-scoped-config.test.ts`

Endpoint and credential configuration can be scoped by deployment region with
`{VAR}_{REGION}`: `REGION_ID=us-east` reads `CHAINLINK_BASE_URL_US_EAST` and
`CHAINLINK_API_KEY_US_EAST`, falling back to the global vars when unset.

## Semantics

- **Validation/failover:** a set but malformed region-scoped URL is ignored with
  a loud `logger.warn` and the global endpoint is used. A region never blocks
  boot because of a bad override.
- **No leakage:** resolution is namespaced per region (`us-east` can only read
  its own suffix); a region-scoped credential equal to the global value logs a
  cross-environment-leakage warning. Secrets stay redacted via
  `redactedConfigView`.
- Region-scoped hosts join the SSRF allowlist so calls to them are permitted.

## Monitoring / operations

- Watch for `[RegionConfig]` warn lines after deploys.
- Verify with `npm run check-config` (redacted) that each region resolves the
  expected endpoints before rollout.

## Rollout / rollback

- **Rollout:** merge (no behavior change without the new vars), then set
  region-scoped vars per deployment and confirm via `--check-config`.
- **Rollback:** unset the region-scoped vars; resolution falls back to the
  globals automatically. Reverting the code is safe because unset scoped vars
  are already no-ops.
