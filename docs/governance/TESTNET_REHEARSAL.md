# Public testnet governance rehearsal (#780)

**Owner:** Governance Working Group
**Status:** runner published; public testnet run pending an operator window
**Surface:** `GET /api/v1/governance/rehearsals/latest`
**Report artifact:** `GOVERNANCE_TRANSPARENCY_DIR/rehearsal-report.json`
**Cadence:** quarterly, and before every contract upgrade or parameter change

## Goal

Exercise proposal creation, voting, resolution, execution, cancellation, and
emergency recovery end-to-end, then publish the outcomes and any follow-up
actions. The rehearsal exists to find process failures (unfunded proposers,
guardian key gaps, unclear cancellation authority) before they matter on
mainnet.

## Scenario matrix

| Scenario | What it proves |
|---|---|
| `happy_path` | Propose → vote → close → queue → timelock → execute; timelock applies from `voting_end` |
| `quorum_not_met` | A minority cannot pass; the defeat is resolved on read because the contract rollback leaves status `Active` |
| `majority_rejected` | Quorum alone is insufficient; `votes_for` must strictly exceed `votes_against` |
| `cancellation` | Only the proposer or admin can cancel; cancellation is final |
| `emergency_override` | The guardian executes immediately; non-guardians are rejected; re-execution is rejected |
| `guardrails` | Below-threshold proposals, double votes, post-close votes, unknown proposals, and cancelled-proposal execution all fail without corrupting state |

The in-memory engine mirrors `contracts/price-oracle/src/governance.rs`,
including Soroban's rollback-on-error behavior: a defeated queue attempt is not
persisted and `get_proposal` resolves it on read.

## Local dry run (automated, runs today)

```bash
cd api
npm run rehearsal:governance -- --write \
  --md ../docs/governance/reports/rehearsal-local.md \
  --now 2026-10-20T00:00:00Z
```

- `--write` publishes `rehearsal-report.json` for `GET /governance/rehearsals/latest`.
- `--md <path>` also writes the Markdown report.
- `--json` prints the machine-readable report.
- `--network` only accepts `local-simulation`; the runner refuses to label a
  simulation as a network run.
- Exit code `0` only when every scenario passes.

Local dry-run evidence for this change: **6/6 scenarios, 33/33 steps passed**
(`api/tests/governance/governance-rehearsal.test.ts` and the CLI run above).

## Public testnet run (operator procedure)

Prerequisites:

1. A funded testnet identity with the proposal threshold:
   `stellar keys generate --global gov-rehearsal --network testnet --fund`.
2. The `GovernanceContract` deployed on testnet and initialized with rehearsal
   config (voting period, timelock, quorum, guardian). See
   [Multi-sig administration](../MULTISIG_ADMINISTRATION.md) for the
   initialization pattern.
3. A guardian identity that is **not** the proposer, and an admin identity that
   is **not** the proposer, so authority checks are meaningful.
4. A public rehearsal issue announcing the window and linking the report.

Steps (each produces a transaction hash for the published report):

1. Record the contract id, network passphrase, ledger, and config in the report
   header.
2. Propose the rehearsal action (a harmless parameter change such as
   `SetDeviationThreshold`) and record `proposal_id`.
3. Vote for with one identity and against with another; attempt a second vote
   from the same identity and record the failure.
4. After `voting_end`, call `queue`; attempt `execute` before the timelock and
   record `TimeLockNotElapsed`.
5. After the timelock, `execute` and confirm `get_proposal` reports `Executed`.
6. Create a second proposal, cancel it as a non-proposer (expect
   `AdminOnly`), then cancel as the proposer and confirm execution fails with
   `ProposalCancelled`.
7. Create a third proposal and use `emergency_execute` from a non-guardian
   (expect `GuardianOnly`), then from the guardian and confirm `Executed`.
8. Publish the report to `rehearsal-report.json` and link it from the rehearsal
   issue.

> A public testnet run requires funded keys and a deployed contract; it cannot
> be executed by CI without secrets. The runner and report format are in place,
> and the local dry run is green. The public run is the remaining operator
> step, tracked as a follow-up on this issue.

## Pass criteria

| Criterion | Required |
|---|---|
| Every scenario in the matrix executed | yes |
| Expected error codes observed for negative steps | yes |
| No state corruption after a rejected action | yes |
| Report includes contract id and transaction hashes for on-chain steps | yes |
| Follow-up actions listed with an owner | yes |

## Published report

`GET /api/v1/governance/rehearsals/latest` returns the last report with its
`network`, `contractId`, config, scenario matrix, step outcomes, and
`followUps`. The report is additive and versioned (`schemaVersion: "1.0"`).

Markdown publication template:

```md
# Governance Rehearsal Report — <date>
- Network: testnet | Contract: <id>
- Participants: proposer <addr>, guardian <addr>, admin <addr>
- Verdict: PASSED/FAILED (scenarios, steps)

| Scenario | Result | Tx refs | Notes |
|---|---|---|---|
| happy_path | PASS | ... | ... |
| quorum_not_met | PASS | ... | ... |
| cancellation | PASS | ... | ... |
| emergency_override | PASS | ... | ... |
| guardrails | PASS | ... | ... |

## Follow-up actions
- [ ] owner — action
```

## Rollout and rollback

- **Rollout:** run locally, publish the report, then repeat on testnet with
  funded identities. Rehearsal actions are limited to reversible parameters
  (`SetDeviationThreshold`); never rehearse with `TransferAdmin` on a live
  environment.
- **Rollback:** a rehearsal proposal can be cancelled by the proposer or admin
  before execution, and the guardian can be used only for the explicit
  emergency step. Nothing in this workflow touches mainnet.
- The report endpoint is read-only; deleting the artifact returns
  `404 GOVERNANCE_DATA_UNAVAILABLE` and does not affect governance operations.

## Completion evidence

- `api/tests/governance/governance-rehearsal.test.ts` — scenario matrix,
  rollback semantics, timelock boundary (execution permitted exactly at the
  execution time), threshold/guardian/cancellation authority, report rendering.
- CLI dry run recorded above.
- Public testnet execution: **not yet run** — requires funded testnet
  identities and a deployed governance contract (follow-up).

## Follow-ups (not in this change)

1. Execute the public testnet rehearsal and publish the report with tx hashes.
2. Add an automated testnet driver (funded identity in CI) once secrets
   management for the rehearsal account exists.
3. Add the rehearsal to the quarterly governance calendar with an owner.
