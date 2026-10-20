# Community release review windows (#779)

**Owner:** Release Management with the Governance Working Group
**Status:** published
**Surface:** `GET /api/v1/governance/release-windows`
**Source artifact:** `GOVERNANCE_TRANSPARENCY_DIR/release-review.json`
**Gate:** `npm run check:release-windows` (in `api/`)

## Goal

Every material change to feeds, the API, or the contract is announced with
enough notice for consumers to review it, and has a public place to send
feedback before it ships. The policy is machine-checkable so a release can be
gated rather than trusted to memory.

## Review windows

| Change class | Minimum notice | Material? | Rationale |
|---|---|---|---|
| `contract` | 14 days | yes | On-chain behaviour and storage cannot be patched quickly |
| `feed` | 10 days | yes | Source/asset/aggregation changes alter prices consumers rely on |
| `api` | 7 days | yes | Clients and SDKs need time to adapt |
| `infrastructure` | 3 days | no | Deployment awareness; correctness is covered by the SLO gate |
| `docs` | 0 days | no | No runtime effect |

Additional rules:

- **Breaking change:** +7 days on top of the class maximum.
- **Feedback channel:** material releases need at least one actionable public
  channel (https URL — the release issue). Docs/infrastructure releases are
  warned, not blocked, when they have none.
- **Owner:** every entry names an accountable owner.
- **Window close:** feedback closes 24h before the release. Releases inside
  that final day still ship, but the report warns
  (`review_window_closed`) that only blocking corrections should be accepted.
- **Withdrawn releases** are compliant by definition; remaining obligations end.

### Emergency path

A security emergency may shorten the window, but not remove accountability:

1. Guardian/admin declares the emergency (`emergency.declaredBy`,
   `declaredAt`, `reason`) no later than the release.
2. Minimum notice is still **24 hours**.
3. A public retrospective is scheduled **within 48 hours** of the release.
4. Missing declaration, late retrospective, or under-24h notice are violations
   and block the gate.

## Calendar contract

`release-review.json` is the published release calendar:

```json
{
  "asOf": "2026-10-20T00:00:00.000Z",
  "releases": [
    {
      "id": "rel-2026-11",
      "version": "v1.4.0",
      "summary": "Raise the deviation threshold",
      "owner": "Release Management",
      "changes": [{ "class": "contract", "description": "SetDeviationThreshold(500)" }],
      "announcedAt": "2026-10-01T00:00:00.000Z",
      "releaseAt": "2026-10-20T12:00:00.000Z",
      "feedbackChannels": ["https://github.com/Stellar-Unified-Price-Oracle/issues/1"],
      "status": "planned"
    }
  ]
}
```

`status` is `planned` (default), `released`, or `withdrawn`. The calendar is
owned by Release Management, updated when a release is scheduled or a date
moves, and reviewed at the monthly community call.

## Gate

```bash
cd api
npm run check:release-windows            # gates scheduled/open entries
npm run check:release-windows -- --json  # machine-readable report
npm run check:release-windows -- --strict # also fails on already-released violations
```

Exit codes: `0` clean, `1` actionable violation, `2` missing/invalid calendar.
Historical violations are reported but do not fail the default gate, so the
check can be enabled before the calendar is fully backfilled.

Suggested CI wiring (after the calendar is published):

```yaml
- name: Community release review windows
  run: cd api && npm run check:release-windows
```

## Rollout and rollback

- **Rollout:** publish the calendar for the next release, run the gate locally,
  link the calendar from the release issue, and enable the CI step.
- **Rollback:** the gate is advisory until wired into CI. If it produces false
  positives, remove the step — do not weaken the notice table. A policy change
  requires a calendar `policy.version` bump and a review by the Governance
  Working Group.
- The API endpoint is read-only and additive; removing the artifact yields
  `404 GOVERNANCE_DATA_UNAVAILABLE`.

## Completion evidence

- `api/tests/governance/release-review-window.test.ts` — exact-minimum notice,
  one-hour shortfall, breaking +7 days, docs-only, missing feedback channel,
  emergency success/late retrospective/under-24h, withdrawal, invalid
  schedule, and gated-vs-historical reporting.
- CLI dry run: `npm run check:release-windows -- --now 2026-10-20T00:00:00Z`.

## Follow-ups (not in this change)

1. Publish the first calendar and wire the gate into CI (requires the artifact
   in the deployment pipeline).
2. Add a GitHub release-issue template that captures the same fields, so the
   calendar is populated from the issue rather than hand-maintained.
3. Add notification automation (Discord/email) when a window opens or is about
   to close.
