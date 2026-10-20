# Noisy-neighbor and quota isolation testing

Owner: API platform maintainers (owner of `api/src/platform/`). Scope: per-key (tenant) allowance enforced by `TenantWindow` and the tier model in `limit-model.ts`.

## What is covered

`api/tests/quota-isolation.test.ts` exercises, without any network or Redis dependency:

| Property | Test group |
| --- | --- |
| A flooding consumer cannot consume another consumer's budget | noisy neighbor |
| Concurrent bursts admit at most `limit` requests | noisy neighbor |
| Replicas on one shared store share a single budget | shared store |
| Store failure degrades to a local per-pod counter and still enforces | shared store |
| Overrides above the tier ceiling, NaN, Infinity, negative, string and fractional values cannot raise the effective limit | bypass attempts |
| Limit `0` is deny-all | bypass attempts |

## Repeatable procedure

1. Run the file with the API vitest config (`api/vitest.config.ts`).
2. For a live-environment check, use the existing `load-tests/` scripts with two API keys of the same tier: drive one key well above its limit while sampling the other. The expected result is HTTP 429 only for the flooding key and unchanged success rate and latency for the quiet key. Thresholds for acceptable latency drift are unspecified here and should be set by the operating team.

## Known boundaries

- With no shared store configured, limits are per pod, so the cluster-wide budget is up to `limit x replicas`. This is documented behavior of `TenantWindow`.
- The layered global/ip/endpoint limiter in `platform/rate-limiter.ts` is defense in depth and is not covered by this file.

## Monitoring, rollout, rollback

- Compatibility: tests only; no runtime change.
- Monitoring: watch existing rate-limit rejection (429) metrics per key.
- Rollout: merge the test file; wire into the normal API test job.
- Rollback: delete the test file and this document; nothing else depends on them.
