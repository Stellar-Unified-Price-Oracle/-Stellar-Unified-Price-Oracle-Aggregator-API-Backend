# Catalog Governance

How a change to the published feed catalog is proposed, reviewed, simulated,
activated, and rolled back — and how emergency powers and conflicts of interest
are constrained while that happens.

Related documents:

- [Multi-Sig Administration](./MULTISIG_ADMINISTRATION.md) — the contract-side
  signer set and proposal execution path this surface calls into
- [Contract Upgrade Governance](./CONTRACT_UPGRADE_GOVERNANCE.md) — the
  contract-code upgrade path, which is a separate process
- [Governance](./GOVERNANCE.md) — repository process (branch protection,
  CODEOWNERS, signed commits)
- [Threat Model](./THREAT_MODEL.md) — trust boundaries the controls below assume

Issues: #774 (governed catalog policy), #775 (pre-approval impact analysis),
#776 (conflict-of-interest register), #778 (emergency action expiry and review).

---

## Owners

| Role | Accountable for |
|---|---|
| Governance lead | Catalog policy proposals, review scheduling, rollback decisions |
| Security reviewer | Independent review of high-impact changes, COI register upkeep, emergency review roster |
| On-call operator | Opening and closing emergency actions, publishing post-action disclosures |
| Release manager | Rollout/rollback of the API surface in this document |

The roles are separation-of-duties roles, not job titles: one person must not
hold the proposer, approver, and emergency-operator roles for the same change.

---

## The policy model

A catalog policy is an immutable, versioned snapshot:

```ts
interface CatalogPolicy {
  version: number;          // 1 = genesis, +1 on every activation
  activatedAt: string;
  proposalId: number | null; // null for genesis
  feeds: FeedPolicy[];
}

interface FeedPolicy {
  asset: string;             // upper-case ticker, e.g. "XLM"
  sources: string[];         // chainlink | redstone | band | reflector
  minSources: number;        // provider floor before a price publishes
  maxDeviationBps: number;   // deviation guard from the previous price
  stalenessSeconds: number;  // age at which a source value is stale
  enabled: boolean;
}
```

Versions are never mutated. Activation appends `version + 1`; every earlier
version remains readable through `GET /api/v1/governance/catalog/policy/versions/:version`,
which is what makes a rollback a normal governed proposal instead of a
privileged escape hatch.

Implementation: `api/src/governance/catalog-policy.ts`.

---

## Lifecycle of a policy change

```
create ──► InReview ──► Approved ──► Activated (new version)
             │  │          │
             │  └── reject ┴──► Rejected
             └── review window lapses ──► Expired
```

1. **Propose.** `POST /api/v1/governance/catalog/proposals` with an explicit
   `baseVersion`, `upserts`, and `removals`. The change is normalized
   (upper-case assets, lower-case provider names) and validated against guard
   rails before it is stored. A change that violates an **error**-severity guard
   rail is rejected with `422 CATALOG_POLICY_INVALID` and the findings.
2. **Simulate.** `POST /api/v1/governance/catalog/proposals/:id/impact` records a
   reproducible impact report on the proposal (see below).
3. **Review.** `POST /api/v1/governance/catalog/proposals/:id/reviews` with
   `{ "decision": "approve" | "reject", "attested": true }`. Reviewers are
   identified by their authenticated credential — a body field can never claim
   another reviewer's identity. Independent approvals required:
   - 2 for a standard change (tightening a guard rail),
   - 3 for a high-impact change,
   and the final approval is refused unless an impact report has been recorded
   and does not block approval.
4. **Timelock.** 24 hours for standard changes, 48 hours for high-impact
   changes. The timelock starts when the final approval lands.
5. **Activate.** `POST /api/v1/governance/catalog/proposals/:id/activate` with an
   `executions` array mapping every on-chain plan action to the multisig
   proposal that carried it. The route verifies each referenced multisig
   proposal contains exactly that action and is executed; the service refuses
   activation if any planned action is unaccounted for. Activation appends the
   new policy version.

### Guard rails

| Code | Severity | Meaning |
|---|---|---|
| `STALE_BASE_VERSION` | error | Change was authored against a policy version that is no longer live |
| `INVALID_ASSET` | error | Ticker is not `^[A-Z0-9]{2,12}$` |
| `UNKNOWN_SOURCE` | error | Provider is not one of the four registered sources |
| `INSUFFICIENT_SOURCES` | error | Fewer than 2 providers back the feed |
| `MIN_SOURCES_BELOW_FLOOR` | error | `minSources` below the 2-provider floor |
| `MIN_SOURCES_EXCEEDS_SOURCES` | error | `minSources` greater than declared providers |
| `DEVIATION_OUT_OF_BOUNDS` | error | `maxDeviationBps` outside 10–2000 |
| `STALENESS_OUT_OF_BOUNDS` | error | `stalenessSeconds` outside 10–3600 |
| `EMPTY_CATALOG` / `NO_ENABLED_FEEDS` | error | Change would leave nothing published |
| `EMPTY_CHANGE` / `NO_OP_CHANGE` | error | Change does not alter the live policy |
| `CONFLICTING_CHANGE` | error | Same asset upserted and removed |
| `UNKNOWN_FEED` | error | Removal of a feed that is not live |
| `TOO_MANY_CHANGES` | error | More than 100 feeds in one change |
| `DEVIATION_LOOSENED`, `STALENESS_LOOSENED`, `MIN_SOURCES_REDUCED`, `SOURCE_SET_REDUCED`, `FEED_DISABLED`, `FEED_ENABLED` | warning (and high-impact) | The change reduces safety margin |

Warnings do not block a change; they force the high-impact lane (three
approvals, 48-hour timelock) and are carried into the impact report so the
reviewer sees them.

### What "high impact" means

A change is high-impact when it adds, removes, enables, or disables a feed, or
when it loosens any guard rail (wider deviation, longer staleness, fewer minimum
sources, fewer providers). High-impact changes need three independent approvals
instead of two, and 48 hours of timelock instead of 24.

### Why the change cannot be silently re-based

The change names the policy version it was authored against. Two things then
happen at activation:

- `baseVersion` is compared with the live version; if another proposal landed
  first the activation fails with `POLICY_DRIFT` rather than re-applying a diff
  against a policy that has moved.
- The guard rails are **re-validated at activation**, not only at proposal time,
  and the on-chain plan is recomputed and compared with the reviewed plan. A
  mismatch fails with `PLAN_DRIFTED`.

### Rollback

`POST /api/v1/governance/catalog/rollbacks` with `{ "targetVersion": N }` creates
an ordinary proposal whose change is the diff from the live policy back to
version N. It carries `kind: "rollback"`, is always treated as high-impact, and
must complete the same review, impact analysis, timelock, and on-chain execution
steps as any other change. Rolling back to the live version is rejected
(`ROLLBACK_TARGET_IS_LIVE`).

---

## The on-chain boundary

The Soroban contract stores a subset of catalog policy: trusted assets, the
source registry, the deviation threshold, and pause state. The API translates a
change into a plan of **contract proposal actions** it can actually express:

| Policy change | Contract action |
|---|---|
| Feed listed / re-enabled | `SetTrustedAsset(asset, true)` |
| Feed removed / disabled | `SetTrustedAsset(asset, false)` |
| Provider newly used by any feed | `AddSource(address, name)` |
| Provider no longer used by any feed | `RemoveSource(address)` |
| Every enabled feed shares one new deviation value | `SetDeviationThreshold(bps)` |

Parameters with no on-chain representation are listed explicitly in
`onChainPlan.offChainParameters` instead of being dropped:

- `maxDeviationBps` when feeds disagree (the contract stores a single value),
- `minSources`,
- `stalenessSeconds`.

Those are enforced by the aggregator/API configuration and must be deployed by
the operator as part of the same change; the plan makes the gap visible at
review time.

Provider addresses are supplied with the proposal. If a provider has no
registered on-chain address the proposal is rejected with
`MISSING_SOURCE_ADDRESS` — the service never invents an address.

Activation requires that each plan action is already carried (and executed) by a
multisig proposal: **the chain moves first, the API mirror follows**. This keeps
the published policy from claiming a state the contract does not have.

---

## Impact analysis (#775)

`POST /api/v1/governance/catalog/proposals/:id/impact` takes the live policy, the
projected feed set, an explicit consumer dependency index, and a cost model:

```json
{
  "consumers": [
    { "id": "mm-a", "assets": ["XLM", "BTC"], "tier": "pro" }
  ],
  "costModel": {
    "pollIntervalSeconds": 30,
    "perSourceFetchCost": 0.0004,
    "perOnChainPublishCost": 0.002,
    "currency": "USD"
  }
}
```

The report contains:

- **Affected feeds** — added / removed / modified / unchanged, sorted.
- **Affected consumers** — count, sorted ids, counts per tier, and a `coverage`
  flag. `partial` means no consumer index was supplied and the estimate is
  explicitly incomplete (it is not reported as "zero exposure").
- **Cost** — current and proposed cost per day, delta per day and per month, and
  delta percent, from the injected cost model.
- **Safety margins** — min sources, provider diversity, deviation headroom, and
  staleness headroom before and after, plus the list of reduced margins.
- **Risk** — `low` / `medium` / `high` / `critical`. A critical report (a feed
  that could not publish under its own guard rails) blocks the final approval.

**Reproducibility.** The report is a pure function of its inputs and
`deterministicHash` is a SHA-256 over their canonical encoding (sorted keys,
sorted feeds, sorted consumer ids). The same inputs produce the same hash on any
replica, at any time; `generatedAt` is deliberately outside the hash. The
recorded report is attached to the proposal, so the numbers a reviewer approved
can be compared with the numbers at activation time.

Cost model inputs are operator-supplied because provider pricing and chain fees
change independently of this repository; a stale default must never be presented
as a measurement.

---

## Conflict-of-interest register (#776)

`api/src/governance/coi-register.ts`.

Decision makers and reviewers declare relationships that could bias a catalog
decision:

```http
POST /api/v1/governance/catalog/coi/attestations
{ "statement": "No undisclosed relationships." }

POST /api/v1/governance/catalog/coi/disclosures
{
  "relationship": "financial",
  "counterparty": "chainlink",
  "scope": "source",
  "details": "consulting retainer, 2025",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "attested": true
}
```

Rules:

- **Scoped.** A declaration applies to one asset, one provider, or the whole
  protocol. Protocol-scoped disclosures recuse on every decision.
- **Time-bounded.** Every declaration carries an expiry of at most 365 days.
  Declarations past their expiry are marked `expired`, and an expired conflict
  **still recuses its author** — the register can no longer prove the
  relationship ended. Re-declaring restores compliance but does not lift the
  recusal for that counterparty.
- **Attested.** Reviewers must attest to the register within 90 days before
  reviewing or countersigning. An expired attestation fails closed
  (`ATTESTATION_REQUIRED`).
- **Withdrawable by the discloser only.** A withdrawal stops the recusal and is
  visible in the register; it does not delete history.
- **Recusal is enforced in the decision path,** not just displayed: a recused
  reviewer is rejected by the catalog review endpoint (`CONFLICT_OF_INTEREST`)
  and by the emergency review endpoint.

`GET /api/v1/governance/catalog/coi/disclosures` is the reviewable register
(filterable by actor and status). `GET .../coi/eligibility?actor=…&assets=…&sources=…`
answers "may this person act on this decision?" with the reasons.

---

## Emergency actions (#778)

`api/src/governance/emergency-actions.ts`.

Emergency powers are **restrictive only**. The only accepted kinds are:

- `pause-feed` (requires `asset`),
- `freeze-source` (requires `source`),
- `halt-publishing` (protocol-wide).

Anything that expands exposure — adding a feed, loosening a guard rail, moving
funds, changing signers — is rejected with `EMERGENCY_KIND_NOT_PERMITTED` and
must use the governed proposal path.

| Control | Bound |
|---|---|
| Expiry | Mandatory. At most **72 hours** per window (`EXPIRY_REQUIRED`, `EXPIRY_TOO_FAR`) |
| Independent review | Reviewer must differ from the author, be attested, and not be recused; due within **24 hours** (`REVIEW_DEADLINE_PASSED`) |
| Renewal | Only a **reviewed** action; at most 2 renewals; each extension ≤ 72 hours; total ≤ 3 windows; a renewal resets the action to `Active` so it needs a fresh countersignature |
| Overturn | A reviewer can `overturn`, which revokes the action immediately |
| Expiry sweep | Reviewed actions become `Expired`; actions that never got a countersignature become `ExpiredUnreviewed` and stay flagged for the incident review |
| Disclosure | Every action requires a published post-action disclosure within 24 hours of closing (`DISCLOSURE_BEFORE_CLOSE` prevents publishing early; `overdueDisclosures()` lists misses) |

Closing an action releases its overlay; `isFrozen(asset)` and
`isSourceFrozen(source)` are derived from open actions only, so an expiry cannot
be forgotten.

### Interaction with catalog activation

A catalog proposal that touches a feed under an active emergency override cannot
be activated (`EMERGENCY_OVERRIDE_ACTIVE`). The override must expire, be revoked,
or be overturned first — an emergency freeze can therefore never be used to
smuggle a policy change past the review lane while the change is masked.

---

## Operating the surface

All endpoints are mounted under the existing admin-authenticated prefix
`/api/v1/governance/catalog`. They are additive; no existing route changed
shape. Each reviewer needs **their own admin credential** — reviewer identity is
the credential, and independence checks compare credentials.

| Endpoint | Purpose |
|---|---|
| `GET /catalog/policy` | Live policy and version history |
| `GET /catalog/policy/versions/:version` | Immutable snapshot |
| `POST /catalog/proposals` | Create a governed change |
| `GET /catalog/proposals[?status=]` | Review queue |
| `GET /catalog/proposals/:id` | Proposal detail |
| `POST /catalog/proposals/:id/reviews` | Approve or reject |
| `POST /catalog/proposals/:id/impact` | Record impact analysis |
| `GET /catalog/proposals/:id/impact` | Read recorded analysis |
| `POST /catalog/proposals/:id/activate` | Activate after timelock |
| `POST /catalog/rollbacks` | Propose a governed rollback |
| `GET/POST /coi/disclosures` | Register |
| `POST /coi/disclosures/:id/withdraw` | Withdraw own declaration |
| `POST /coi/attestations` | Attest to the register |
| `GET /coi/eligibility` | Recusal check |
| `GET /emergency`, `GET /emergency/:id` | Open actions |
| `POST /emergency` | Open a restrictive action |
| `POST /emergency/:id/review` | Independent countersign or overturn |
| `POST /emergency/:id/renew` | Bounded extension |
| `POST /emergency/:id/revoke` | Early close |
| `POST /emergency/:id/disclosure` | Post-action disclosure |
| `GET /emergency/monitoring` | Overdue reviews, overdue disclosures, open actions |

### Audit and monitoring

Every state change emits a structured audit event through the existing
HMAC-chained audit log:

`governance.catalog_proposal_created`, `governance.catalog_proposal_reviewed`,
`governance.impact_simulated`, `governance.catalog_policy_activated`,
`governance.catalog_rollback_proposed`, `governance.coi_disclosed`,
`governance.coi_withdrawn`, `governance.coi_attested`,
`governance.emergency_opened`, `governance.emergency_reviewed`,
`governance.emergency_renewed`, `governance.emergency_revoked`,
`governance.emergency_disclosed`.

Suggested alerts (wire to the existing Prometheus/Alertmanager stack):

- `emergency.overdueReviews.length > 0` for more than the review window — an
  emergency power is running without an independent countersignature.
- `emergency.overdueDisclosures.length > 0` — a post-action disclosure is
  overdue.
- A proposal sitting in `InReview` past `reviewDeadlineAt` (`sweepExpired`
  reports them) — review capacity is falling behind.
- Repeated `EMERGENCY_OVERRIDE_ACTIVE` activation failures — an override is
  masking a planned change and the two processes need reconciling.
- Any `CONFLICT_OF_INTEREST` / `ATTESTATION_REQUIRED` rejection — expected
  occasionally; a spike means the register or roster is stale.

Polling `GET /emergency/monitoring` once per minute is enough for the first two;
the other three come from the audit stream.

---

## Compatibility and rollout

- **No schema migrations**, no contract change, no new required environment
  variables. The router is mounted inside the existing admin prefix and reuses
  the existing admin auth, audit log, and error envelope.
- **State is in-process** (like the existing proposal service). A restart resets
  proposals, policies, disclosures, and emergency actions to genesis. This is
  acceptable for the admin surface's current role but is the main prerequisite
  for production use — see follow-ups.
- **Rollout.** Deploy with the routes mounted but unused; exercise read paths
  (`GET /catalog/policy`) to confirm auth and wiring; then run one standard
  change end to end in staging with three distinct reviewer credentials; then
  enable the emergency path. Keep the emergency roster documented before the
  first real pause.
- **Rollback.** Revert the commit and redeploy: the feature is additive, holds no
  durable state, and no consumer contract depends on it. If only the behavior
  must be disabled, leave the routes mounted — nothing activates without an
  explicit, reviewed, timelocked request.

---

## Known limitations and follow-ups

1. **No durable store.** Policies, proposals, COI declarations, attestations,
   and emergency actions live in memory. They need the same durable-store
   treatment the API key store and webhook store received (#601, #609) before
   multi-replica production use, otherwise replicas disagree about the live
   policy version.
2. **Credential identity is a prefix, not a principal.** Actor identity is the
   first 16 characters of the authenticated admin key. That is sufficient to
   stop one caller from claiming to be another, but it is not a durable
   principal id; a key rotation changes the reviewer's identity. A reviewer
   directory (credential → person, with revocation) belongs with the store.
3. **No Prometheus metrics yet.** The controls above are observable through the
   audit log and `/emergency/monitoring`. Gauges for open emergency actions,
   overdue reviews, overdue disclosures, and policy version would make the
   suggested alerts cheaper.
4. **`minSources` and `stalenessSeconds` are off-chain only.** The contract has
   no field for them. If the contract should enforce them, that is a contract
   change with its own upgrade governance and SDK review.
5. **Baseline repository health (separate from this feature).** At the time of
   this change several files still carry merge damage unrelated to catalog
   governance (missing imports/members in `api-key-manager.ts`,
   `api-key-store.ts`, `index.ts`, `webhooks.ts`, `metrics.ts`, and others).
   Type-checking the whole API fails on those files independently of this
   feature; see the pull request for the exact list.

---

## Verification

The acceptance evidence lives in:

- `api/tests/governance/catalog-governance.test.ts` — guard rails, lifecycle,
  approvals, timelocks, drift detection, on-chain execution gating, rollback,
  and impact-report determinism, cost, margins, and blocking behavior.
- `api/tests/governance/governance-safeguards.test.ts` — COI declaration
  validity, recusal scope and expiry, attestation expiry, recused reviewer
  rejection, emergency expiry/review/renewal/expiry-sweep/disclosure bounds, and
  the override/activation interaction.

```
cd api && npx vitest run tests/governance/catalog-governance.test.ts tests/governance/governance-safeguards.test.ts
```
