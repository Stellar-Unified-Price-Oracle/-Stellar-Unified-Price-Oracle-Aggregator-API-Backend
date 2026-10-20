# Treasury transparency dashboard (#781)

**Owner:** Treasury Committee (3-of-5 multisig)
**Status:** published
**Surface:** `GET /api/v1/governance/treasury` and
`/portal/governance/treasury.html`
**Source artifact:** `GOVERNANCE_TRANSPARENCY_DIR/treasury-snapshot.json`
**Update cadence:** declared by the snapshot (`updateCadenceHours`, default 24h);
stale after 1.5x cadence

## Scope

Publishes treasury **inflows, outflows, balances, and policy allocations** with
a source reference for every entry, and reconciles them exactly:

```
openingBalance + inflows - outflows == closingBalance
```

Supported: per-asset reconciliation in integer minor units, provenance
reporting, policy allocation against targets, freshness reporting.
Not supported: fiat or cross-asset valuation. Amounts are never converted to a
common currency because there is no in-house price source for treasury assets
and a made-up valuation would misstate the treasury.

## Reconciliation rules

| Rule | Behavior |
|---|---|
| Integer arithmetic | Amounts are non-negative integer strings in minor units; no floating point |
| Exact equality | A non-zero delta is an **error** (`balance_delta`) and marks the report `unreconciled` |
| Duplicate ids | Entry counted once; an error break (`duplicate_entry_id`) is published |
| Missing source | Every entry must carry `source.ref`; a missing source is an error (`missing_source_reference`) |
| Unknown asset | Entry for an asset without a declared position is excluded from reconciliation and warned |
| Entry after `asOf` | Warned (`entry_after_as_of`) because it implies the period cut is inconsistent |
| Policy targets | Must sum to 10000 bps; otherwise warned (`policy_targets_incomplete`) |
| Policy drift | Actual outflow share vs target, tolerance 500 bps; drift is a **warning**, not a reconciliation error |

Policy allocation is measured on **period outflows**, because balances are not
tracked per policy on-chain. The response states this explicitly
(`measuredOn: "period_outflows"`).

## Provenance

Each ledger row exposes `source: { kind, ref, url? }`:

- `kind` is one of `ledger`, `transaction`, `invoice`, `signature`, `account`.
- `ref` is the ledger sequence, transaction hash, invoice id, or account id.
- `url` is optional; when present the dashboard links to it.

`provenance.complete` is false if any entry lacks a source, and the report is
`unreconciled` in that case. A treasury table without traceable rows is not
transparency.

## Snapshot contract

```json
{
  "asOf": "2026-10-20T00:00:00.000Z",
  "network": "testnet",
  "treasuryAccount": "G...",
  "updateCadenceHours": 24,
  "assets": [
    {
      "asset": "XLM",
      "decimals": 7,
      "openingBalance": "1000000000",
      "closingBalance": "1200000000",
      "source": { "kind": "account", "ref": "G..." }
    }
  ],
  "policy": {
    "version": "2026-Q4",
    "approvedAt": "2026-10-01T00:00:00.000Z",
    "approvedBy": "Treasury Committee (3-of-5)",
    "reference": "https://.../treasury-policy",
    "allocations": [
      { "policy": "operations", "targetShareBps": 3333 },
      { "policy": "security", "targetShareBps": 6667 }
    ]
  },
  "entries": [
    {
      "id": "tx-hash-or-invoice",
      "timestamp": "2026-10-19T10:00:00.000Z",
      "direction": "inflow",
      "asset": "XLM",
      "amount": "500000000",
      "category": "slash",
      "policy": "operations",
      "source": { "kind": "transaction", "ref": "abc123", "url": "https://stellar.expert/tx/abc123" }
    }
  ]
}
```

## API

| Query | Behavior |
|---|---|
| `?asset=XLM` | Filters reconciliation and allocation to one asset; unknown asset → `404 TREASURY_ASSET_NOT_FOUND` |
| `?since=<iso>` | Filters the ledger rows (reconciliation still uses the full period) |
| `?limit=1..500` (default 100) | Caps ledger rows returned |

Response includes `status` (`reconciled`/`unreconciled`), `freshness`,
`updateCadence`, `reconciliation.assets[]`, `policyAllocation.byAsset[]`,
`provenance`, `ledger[]`, `breaks[]`, and `warnings[]`.

## Dashboard

`/portal/governance/treasury.html` renders the endpoint: reconciliation table,
policy allocation per asset, findings, and the ledger with source links. It
shows the snapshot `asOf`, update cadence, policy version and reference, and
states that amounts are never converted to a common currency. When the endpoint
is unavailable the page shows the error and an `Unavailable` badge — it never
renders an empty treasury as zero.

## Monitoring

| Metric | Meaning | Suggested alert |
|---|---|---|
| `treasury_reconciled` | 1 when every asset reconciles | 0 for two publish cycles |
| `treasury_balance_breaks` | error-severity breaks | > 0 |
| `treasury_snapshot_age_seconds` | snapshot age | > 129600 at 24h cadence |

`warnings` (drift, stale, unmapped policy) are visible on the dashboard and in
the payload but do not page on their own; they are reviewed by the Treasury
Committee at the publish cadence.

## Rollout and rollback

- **Rollout:** publish the snapshot, run
  `curl -s $API/api/v1/governance/treasury | jq '.data.status'` and confirm
  `reconciled`, then open the dashboard and confirm every ledger row links to
  a source.
- **Rollback:** remove/rename `treasury-snapshot.json`. The API returns
  `404 GOVERNANCE_DATA_UNAVAILABLE` and the dashboard shows "Unavailable".
  Publishing a corrected snapshot is the normal repair path; no schema change
  is required for additive fields.
- The endpoint is read-only and additive; it does not touch treasury signing
  keys or the multisig contract.

## Completion evidence

- `api/tests/governance/treasury-transparency.test.ts` — reconciliation,
  balance break, duplicate id, missing provenance, unknown asset, policy drift,
  invalid targets, staleness, formatting boundaries.
- `api/tests/governance/transparency-routes.test.ts` — asset filter, ledger
  limit, 404/422 responses, and static dashboard wiring.

## Follow-ups (not in this change)

1. Publish policy allocations against **balances** once per-policy on-chain
   accounts exist (today only period outflows are measurable).
2. Add an automated reconciliation job that fails closed when the artifact is
   stale, instead of relying on the read path to report staleness.
3. Add a valuation source so the dashboard can show a fiat reference without
   inventing one; until then per-asset amounts are the contract.
