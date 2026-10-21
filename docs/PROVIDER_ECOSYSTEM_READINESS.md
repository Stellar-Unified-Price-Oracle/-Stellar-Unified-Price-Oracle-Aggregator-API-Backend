# Provider transport, sandbox credentials, and cutover readiness

Owner: Provider ecosystem maintainer (implementation: @willy-de7). The release
operator owns execution; an independent on-call reviewer owns the go/no-go.
Scope: the four repository HTTP adapters: chainlink, redstone, band, reflector.
This procedure is mandatory before changing an endpoint, transport schema,
authentication mechanism, or provider membership of a publishing feed.

## Versioned transport evidence (#691)

`services/aggregator/tests/fixtures/provider-transport/v1.json` is an immutable
versioned request/response envelope. Each record pins the provider, contract
version, status, capture provenance, request method/path/parameters, HTTP status,
response body, and expected bigint price, decimals and provider observation time.
`repository-v1` describes this repository's adapter contract, not a vendor API
version or a claim of production conformance. Captures come from the local
stub; they contain no live credentials or production data.

The `chainlink` adapter currently targets a CryptoCompare-style HTTP endpoint;
it is not a Chainlink node RPC adapter. Likewise the HTTP Reflector adapter must
not be equated with the Stellar Reflector contract interface. Verify the actual
configured endpoint against its owner before a production migration:

- [CryptoCompare/Coindesk price contract](https://developers.coindesk.com/documentation/legacy/Price/SingleSymbolPriceEndpoint)
- [RedStone HTTP API](https://github.com/redstone-finance/redstone-api/blob/main/docs/HTTP_API.md)
- [Reflector public contract documentation](https://reflector.network/docs)

No authenticated upstream recordings or specific future release announcements
were supplied with these issues. There are currently **no verified announced
versions** in the fixture catalog. Do not invent vendor versions or relabel a
synthetic candidate as announced. Upstream compatibility remains unapproved
until captured and reviewed; the tests establish repository transport behavior.

To refresh local recordings, start `node scripts/stub-oracle-server.mjs`, then
run `node scripts/record-provider-transport.mjs http://127.0.0.1:4010`. Stop the
stub afterward. The recorder accepts loopback destinations only. Inspect the
request, payload, redaction and expected scale before committing. To add a new
contract, create a new JSON envelope under the same fixture directory; preserve
older records until their deployed adapter versions have retired.

For an announced upstream release, the maintainer must attach its official
announcement URL, API version and effective date to the migration ticket;
record a sanitized request/response from the vendor sandbox and add a record
with `status: announced`, a distinct `contractVersion`, its real capture source,
and `provenance.upstreamAnnouncement`. The replay suite automatically tests
all current and announced records through the real adapters. An incompatible
announced response must fail CI until adapter support is added. Add negative
records/tests for the changed fields; never relax validation to make unknown
envelopes appear valid. If there is no vendor sandbox, record the documented
example and label provenance as a documentation example, not a live recording.

Measurement: `npm exec --workspace services/aggregator -- vitest run tests/provider-transport.test.ts`.
It checks requests, scale, timestamps, all four adapters, additive metadata,
unknown envelopes, missing assets, zero/negative/nonfinite prices, and announcement
provenance. Existing `issue-584-response-validation.test.ts` covers additional
schema boundaries. The maintainer reviews upstream announcements monthly and
before each release; attach the date, sources checked and any pending version
to the migration ticket, including an explicit “none announced” result.

## Isolated sandbox credential lifecycle (#692)

Supported issuance scope is the local provider simulator, which is the only
credential issuer operated by this repository. Third-party vendor credentials
must be issued/revoked by the vendor; this tool does not generate valid vendor
API keys. The only credential-bearing adapter today is chainlink. Other
adapters remain unauthenticated, with the same outbound isolation policy.

Use a dedicated unprivileged sandbox process and a private temporary directory:

```sh
sandbox_dir=$(mktemp -d)
npx tsx scripts/rotate-sandbox-provider-credentials.ts "$sandbox_dir/lease.json" http://127.0.0.1:4010 3600000
export SANDBOX_PROVIDER_LEASE_FILE="$sandbox_dir/lease.json"
export PROVIDER_ENVIRONMENT=sandbox
export CHAINLINK_BASE_URL=http://127.0.0.1:4010
export REDSTONE_BASE_URL=http://127.0.0.1:4010
export BAND_BASE_URL=http://127.0.0.1:4010
export REFLECTOR_BASE_URL=http://127.0.0.1:4010
node scripts/stub-oracle-server.mjs
```

Unset all global and regional `*_API_KEY` variables in sandbox processes. Run
aggregator and stub with the same private lease file and exact loopback origin.
The rotation command issues a random 256-bit sandbox token on first use or
expiry, rotates when 25% of its TTL remains, and preserves a healthy lease.
Use the optional `--watch` argument after the TTL to run renewal automatically
in a supervised process; it checks at one eighth of the TTL (at most 60 seconds),
exits nonzero on renewal failure, and stops cleanly on SIGINT/SIGTERM. Alternatively,
schedule the same command once per minute for the default one-hour TTL; for
shorter TTLs schedule more frequently than a quarter TTL. Invalid TTLs fail.
TTL range is 1 second to 24 hours. An atomic rename publishes a mode-0600 lease;
CLI output contains only expiry and rotation status. Do not commit lease files.

The adapter reads the file for every authenticated request, so rotation needs
no restart. The stub checks the active token and expiry on every request;
previous tokens stop working immediately after replacement (no grace overlap).
Expiry is exclusive; future-issued, wrong-origin, production-labeled, malformed
and missing leases fail closed. Filesystem ownership is the trust boundary;
do not share this directory with production identities. No production Vault
namespace is read by this workflow.

`NODE_ENV=test`, `NODE_ENV=development`, or `PROVIDER_ENVIRONMENT=sandbox` rejects
nonempty raw provider credentials, including regional overrides, before config
loads and again before credential use. Configured URLs and outgoing HTTP
requests in those environments must use loopback hosts, even when SSRF checks
are disabled. Production environments retain existing regional credential
resolution. The stub never logs the query string, so tokens do not enter its
request log. An unauthenticated stub remains supported when no lease file is
configured, for existing hermetic integrations; no raw provider credential is
accepted in this mode by the sandbox adapter.

Operational checks: watch rotation command exit status and `expiresAt`; alert
when expiry is less than twice the scheduler interval. Stop on renewal failure;
do not fall back to a production key. Reissue a sandbox lease to recover from
expiry/corruption, then confirm one authenticated price fetch. Rollback means
restore the previous application image and **issue a new sandbox lease**;
never reactivate an expired/replaced token. Stop both processes before deleting
the temporary directory. Production rollout is unaffected unless a nonproduction
runtime was previously using a production key; such deployments must now use
an isolated stub or a separately reviewed vendor sandbox integration.

## Stable error taxonomy (#693)

`SourceFetchOutcome.failure` adds `{ category, retryable }` while preserving
`price`, `failureKind`, and `fetchWithBackoff` compatibility. Consumers use the
category, never provider messages. Raw exceptions remain in internal operator
logs; response evidence remains in the existing redacted archive. Do not expose
raw transport exceptions (which may contain authentication parameters) in HTTP
responses or metric labels.

| Category | Trigger | Automatic retry | Operator action |
| --- | --- | --- | --- |
| authentication | HTTP 401/403 | no | check lease expiry/permissions; rotate |
| rate-limited | HTTP 429 | bounded backoff | lower polling rate/check quota |
| timeout | timeout codes, 408/504 | bounded backoff | inspect provider latency |
| unavailable | 5xx, DNS/connection failure | bounded backoff | check outage and quorum |
| invalid-payload | schema/price violation | no | compare pinned fixtures; page owner |
| no-price | valid absent quote, unsupported asset, HTTP 404 | no | verify feed assignment |
| budget-exhausted | local daily budget | no | wait for rollover/check budget |
| circuit-open | local breaker | no | inspect source recovery |
| policy-blocked | SSRF or sandbox rejection | no | correct isolated configuration |
| unknown | unrecognized exception | no | inspect internal diagnostic context |

Transport retries remain bounded at three attempts with jitter. Authentication
and policy failures now stop immediately. Invalid payloads no longer mark a
source successful; they update failures, health and breaker state. A valid
absent quote does not manufacture a last-success timestamp. Watch existing
source latency, requests, invalid-payload and breaker metrics plus
`oracle_provider_failures_total{source,category}`. The new counter counts terminal
outcomes and local skips; use existing request counters to observe each retry.
Alert on authentication/policy errors immediately, and sustained invalid-payload
or unavailable increases. Roll out one sandbox/canary first; retain old outcome
fields until consumer migration. To roll back, restore the prior image and
monitor quorum; do not disable response validation.

## Mandatory cutover checklist and decision (#694)

The gate is an operator review command, not an automatic endpoint switch.
The release operator must attach its successful output to the deployment ticket;
the independent reviewer must verify the linked artifacts and the complete feed
list against deployed catalog policy before authorizing the config change.
The command validates measurements/attestations; it cannot authenticate artifact
contents or discover omitted feeds. Deployment automation must not treat an
unsigned JSON file alone as approval.

1. Name owner, independent reviewer, old/new versions, endpoints, regions,
   assets and pinned image/config digests. Link official upstream contract
   evidence, passing current/announced fixture report and sandbox isolation test.
2. Shadow-read candidate and incumbent without publishing the candidate or
   counting it as an extra independent source. Budget the extra calls and
   credentials. For **every affected feed**, collect at least 24 hours and
   1,000 paired samples; preserve raw correlation IDs, times, decimals, errors,
   stale/missing observation counts, p99 latency and normalized deviation.
   Normalize both prices to a common scale with `median.ts` before comparison;
   compute deviation as `abs(candidate - incumbent) / incumbent * 10000`.
3. Require error rate <=0.1%, zero stale or observation-unverified samples,
   maximum deviation <=50 bps, and p99 latency <=5,000 ms. Missing provider
   observation time is unverified; local fetch time is not evidence of freshness.
   Current adapters without provider times therefore need a separately reviewed
   contract change before meeting this gate. Thresholds are fixed safety policy;
   changing them requires a separate reviewed change, not a JSON override.
4. Compare each feed's required quorum with healthy **independent** sources
   after cutover and after candidate loss; both must meet the configured quorum.
   Two versions of the same upstream count once. Rehearse candidate outage,
   authentication rejection, malformed payload, quota exhaustion and stale reads.
   If quorum fails, keep the feed unpublished rather than lower its quorum.
5. Document rollback owner, exact previous image/config, credential handling,
   publishing fence and restart commands. Rehearse restoration in <=300 seconds;
   capture health, breaker, quota and publication recovery evidence. Never replay
   candidate shadow values into publication during rollback.
6. Fill `docs/provider-cutover-evidence.example.json`, with real artifact links
   and real measurements. The template intentionally says `no-go`. Run
   `npx tsx scripts/review-provider-cutover.ts EVIDENCE.json`; exit 0 means all
   numeric/structural checks passed **and** an explicit `go` was recorded. Any
   missing evidence, failed threshold, stale/future review or `no-go` exits 1.
   Reviews expire after 24 hours. Record reviewer sign-off and command output.
7. After approval, canary one region/feed, verify health, source error categories,
   median deviation, staleness, budget and quorum each polling interval for 30
   minutes, then expand one region at a time. Roll back immediately on a breached
   gate threshold, publication gap or quorum loss; fence candidate publication,
   restore the pinned config/image and confirm quorum and fresh publication.

Completion evidence is the fixture report, sandbox lifecycle report, per-feed
shadow report, quorum table, rollback rehearsal, independently signed decision,
and post-cutover monitoring record. `provider-lifecycle.test.ts` covers pass,
threshold equality, missing evidence, malformed input, stale/future review,
duplicate feeds, no-go, independent review and all failure thresholds. Run both
new suites using the command below; CI's aggregator test job includes them.

```sh
npm exec --workspace services/aggregator -- vitest run tests/provider-lifecycle.test.ts tests/provider-transport.test.ts tests/provider-sandbox-stub.test.ts
```

Rollback of this gate requires retaining the manual checklist and independent
review; removing the CLI must never be interpreted as cutover approval.
