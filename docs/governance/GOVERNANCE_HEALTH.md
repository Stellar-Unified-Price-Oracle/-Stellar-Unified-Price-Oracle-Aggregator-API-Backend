# Governance participation and quorum health (#777)

**Owner:** Governance Working Group
**Status:** published
**Surface:** `GET /api/v1/governance/health`
**Source artifact:** `GOVERNANCE_TRANSPARENCY_DIR/governance-snapshot.json`
**Update cadence:** nightly (24h); stale after 36h

## Scope

The endpoint publishes four measurements that answer whether governance is
actually working, not just whether proposals exist:

1. **Participation** — how many wallets and how much voting power take part.
2. **Delegation concentration** — whether voting power is spread across
   delegates or held by a few.
3. **Quorum attainment** — how often closed proposals reach the configured
   quorum, and by how much.
4. **Abstention** — the share of eligible power that stays out of a vote.

Supported: aggregate reporting over a snapshot produced from the governance
contract and token balances. Not supported: individual voter profiles,
delegate identities, per-wallet voting power, or any inference that could
re-identify a voter.

## Privacy-safe methodology

| Rule | Implementation |
|---|---|
| No addresses | Voter, delegator, and delegate addresses never leave the module |
| No individual power | Only shares, ratios, HHI, Gini, and top-N aggregates are emitted |
| k-anonymity | Any delegation distribution backed by fewer than `k = 10` delegates is withheld entirely (`delegation.suppressed = true`) |
| Rounding | Ratios are rounded to 4 decimal places; counts are integers |
| Aggregation only | No delegation edges, no per-proposal voter lists, no timing fingerprint of individual votes |

The coherent minimum cohort (`k = 10`) is fixed in code
(`DEFAULT_MIN_COHORT_SIZE`) and is not client-controllable: a `?minCohortSize=`
override would let a caller defeat the suppression, so it is deliberately not
part of the API contract.

### Definitions

| Field | Definition |
|---|---|
| `participation.voterTurnout` | Mean over proposals of `wallets that voted / eligible wallets at the snapshot` |
| `participation.powerTurnout` | Mean over proposals of `(votesFor + votesAgainst) / eligibleVotingPower` |
| `quorum.attainmentRate` | Share of closed proposals whose for+against power met quorum |
| `quorum.proposals[].marginBps` | `(castPower - quorum) / quorum * 10000`; negative means quorum was missed |
| `delegation.hhi` | Sum of squared delegate power shares; `1/HHI` is the effective number of delegates |
| `delegation.gini` | Gini coefficient of delegate voting power (0 = equal, 1 = one holder) |
| `abstention.nonParticipationRate` | Mean eligible power share that voted neither for nor against |
| `abstention.explicitAbstentionRate` | `abstain / (for + against + abstain)`, only when explicit abstain power is recorded |

### Abstention and the binary contract

`GovernanceContract.vote(voter, proposal_id, support: bool)` has no third
option, so on-chain abstention cannot be expressed today. The report therefore
publishes `nonParticipationRate` as the operational abstention measure and
`explicitAbstentionRate` when a deployment records explicit abstain power.
The contract gap is tracked as a follow-up; the metric does not pretend the
binary vote is a three-way vote.

### Delegation and the contract

The contract computes voting power from the SEP-41 token balance and has no
delegation primitive. Delegation concentration is therefore measured over the
delegation records supplied by the snapshot producer (for example a delegation
program tracked off-chain). When fewer than `k` delegates are recorded the
report says so rather than publishing a meaningless concentration number.

## Snapshot contract

```json
{
  "asOf": "2026-10-20T00:00:00.000Z",
  "network": "testnet",
  "token": { "symbol": "ORACLE", "decimals": 7 },
  "eligibleVoters": 412,
  "totalVotingPower": "125000000000",
  "delegations": [
    { "delegator": "G...", "delegate": "G...", "power": "10000000" }
  ],
  "proposals": [
    {
      "id": 12,
      "status": "Executed",
      "votesFor": "40000000000",
      "votesAgainst": "9000000000",
      "abstainPower": "0",
      "eligibleVotingPower": "125000000000",
      "quorumRequired": "25000000000",
      "voters": 84
    }
  ]
}
```

All power values are integer strings in the token's minor units. The producer
is responsible for reading the contract at a single ledger and for not mixing
snapshots from different ledgers. `status` uses the contract's
`ProposalStatus` values.

## Response contract

`GET /api/v1/governance/health?trailingWindow=10` (1..100, default 10) returns
`{ success, data }` where `data` contains `participation`, `delegation`,
`quorum`, `abstention`, `freshness`, `methodology`, and `alerts`.
Fields are additive; consumers must ignore unknown fields.
`methodology.version` identifies the calculation contract.

## Monitoring

Prometheus gauges (emitted on every successful read):

| Metric | Meaning | Suggested alert |
|---|---|---|
| `governance_voter_turnout_ratio` | mean wallet turnout | < 0.10 for two consecutive snapshots |
| `governance_power_turnout_ratio` | mean power turnout | < 0.20 for two consecutive snapshots |
| `governance_quorum_attainment_ratio` | share of closed proposals reaching quorum | < 0.50 |
| `governance_delegation_hhi` | concentration index (absent when suppressed) | > 0.25 |
| `governance_top_delegate_share` | largest delegate share | > 0.333 |
| `governance_abstention_rate` | non-participation share | informational |
| `governance_snapshot_age_seconds` | snapshot age | > 129600 (36h) |

`alerts` in the payload mirrors these conditions with human-readable messages.
A stale snapshot is never silently served as fresh: `freshness.status` becomes
`stale` after 1.5x the cadence.

## Rollout and rollback

- **Rollout:** publish `governance-snapshot.json`, verify
  `GET /governance/health` returns `freshness.status = "fresh"`, then wire the
  Grafana panels and alert rules to the gauges.
- **Rollback:** remove or rename the artifact. The endpoint returns
  `404 GOVERNANCE_DATA_UNAVAILABLE` instead of serving stale numbers, and the
  dashboard/alerts must treat that as "no data", not zero.
- The route is additive and mounted before the admin router; no admin key or
  proposal-route behavior changes.

## Completion evidence

- `api/tests/governance/governance-health.test.ts` — normal, boundary
  (`k = 10`), and failure cases: stale snapshot, missed quorum, concentrated
  delegation, empty history, privacy suppression and address non-disclosure.
- `api/tests/governance/transparency-routes.test.ts` — 200 / 400 / 404 / 422
  behavior and cache headers.
- Manual: `curl -s $API/api/v1/governance/health | jq '.data.delegation'`.

## Follow-ups (not in this change)

1. Add an explicit abstain option to the governance contract and publish the
   third tally; the report already accepts `abstainPower`.
2. Add on-chain delegation to the contract, then derive the snapshot directly
   from contract events rather than an operator-supplied delegation list.
3. Automate snapshot production from Soroban RPC and alert on producer failure.
