# Soroban Storage Rent Budget

Closes #376.

## Problem

Soroban persistent-storage entries (this contract's `PriceHistory(asset)`
entries) and the shared instance-storage entry (`Admin`, `GovernanceConfig`,
`GovernanceProposal`, `MultiSigConfig`) carry a time-to-live (TTL) measured
in ledgers. If nobody pays to extend an entry's TTL before it hits the
network's minimum floor, the entry is archived and reads fail until it is
restored — breaking price history reads and governance state.

## TTL extension

`PriceOracleContract::extend_storage_ttl` (see
`contracts/price-oracle/src/contract.rs`) bumps:

- the instance storage entry TTL (covers `Admin`, `GovernanceConfig`,
  `GovernanceProposal`, `MultiSigConfig`, `DeviationThreshold`, etc. — Soroban
  bills and expires all `.instance()` keys as a single ledger entry, so
  there is no separate GovConfig/proposal TTL to manage), and
- the persistent `PriceHistory(asset)` entry for every asset the contract
  knows about (`get_all_assets`).

It extends each entry's TTL from a floor of ~7 days (`120_960` ledgers) out
to ~90 days (`1_555_200` ledgers) whenever called, so a job run weekly has a
wide safety margin even if a run is missed.

The function takes no admin auth — extending TTL only pays rent and cannot
mutate oracle or governance state, so any account can fund it.

## Scheduled job

Run `extend_storage_ttl` on a schedule via `scripts/extend-ttl-job.ts`
(added alongside this doc):

```bash
npm run rent:extend            # testnet
npm run rent:extend -- --mainnet
```

Wire the mainnet invocation into the existing deployment cron/CI schedule
(wherever `deploy-soroban.js` is triggered from) at a weekly cadence.

## Alerting

The job prints the ledger sequence and computed expiration ledger for the
instance entry and each price-history entry it touched. Alert (page /
Slack, via whatever channel already carries oracle-source-down alerts — see
`docs/runbooks/oracle-source-down.md`) when:

- the job fails to run for two consecutive scheduled windows, or
- any entry's remaining TTL, as reported by `stellar contract read` /
  `getLedgerEntries` for the relevant key, drops below the 7-day floor
  before the next scheduled run.

## Who funds the rent

The account submitting the `extend_storage_ttl` transaction pays the rent
fee for that transaction. This must be a funded operational account (the
same class of account used for scheduled maintenance transactions today,
not the contract admin key) — track its XLM balance under the same
budget/alerting the aggregator's submission account already uses, since
both are transaction-fee-funded, unprivileged accounts.
