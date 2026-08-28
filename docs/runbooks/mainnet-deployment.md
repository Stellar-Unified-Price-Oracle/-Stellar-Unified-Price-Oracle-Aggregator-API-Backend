# Mainnet Deployment Runbook

Repeatable, reviewable steps for deploying the oracle contract to Stellar mainnet.

## Prerequisites

- A funded mainnet account dedicated to deployment (not a personal key).
- `soroban-cli` configured with a `mainnet` network alias.
- Access to the CI-managed secrets store for the deployer key.
- Sign-off from a second engineer (see `.github/CODEOWNERS`) before running any step against mainnet.

## 1. Initialize the contract

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/oracle_contract.wasm \
  --source deployer --network mainnet
# record the returned CONTRACT_ID
soroban contract invoke --id $CONTRACT_ID --source deployer --network mainnet \
  -- initialize --admin $ADMIN_ADDRESS
```

Verify:

```bash
soroban contract invoke --id $CONTRACT_ID --source deployer --network mainnet -- get_admin
```

## 2. Register price sources

```bash
soroban contract invoke --id $CONTRACT_ID --source deployer --network mainnet \
  -- register_source --source_id chainlink --address $CHAINLINK_ADDR
```

Repeat per source. Verify with `-- list_sources`.

## 3. Configure trusted assets

```bash
soroban contract invoke --id $CONTRACT_ID --source deployer --network mainnet \
  -- add_trusted_asset --asset $ASSET_CODE --issuer $ISSUER_ADDRESS
```

Verify with `-- list_trusted_assets`.

## 4. Register CONTRACT_ID with the API layer

- Set `ORACLE_CONTRACT_ID=$CONTRACT_ID` in the mainnet environment config (see `config/`).
- Restart/redeploy the API service so it reads the new contract ID.
- Verify: `curl https://<api-host>/health` reports the configured contract ID and reachable RPC endpoint.

## Verification checklist

- [ ] `get_admin` returns the expected admin address.
- [ ] `list_sources` matches the intended source set.
- [ ] `list_trusted_assets` matches the intended asset set.
- [ ] API `/health` reports the new `CONTRACT_ID` and healthy RPC connectivity.
- [ ] A test price submission and read round-trips correctly.

## Rollback

- The API layer can be rolled back independently by reverting `ORACLE_CONTRACT_ID` to the previous contract and redeploying — the prior contract instance remains live and unaffected.
- Soroban contracts are immutable once deployed; there is no in-place rollback of a bad contract. If a deployed contract is misconfigured, deploy a corrected instance under a new `CONTRACT_ID` and repeat steps 1–4, then repoint the API layer.
- Keep the previous `CONTRACT_ID` recorded in the deployment log until the new instance has been verified in production for at least 24 hours.

## Testing this runbook

This runbook must be exercised end-to-end on `testnet` first, then on a fresh mainnet account, before being used for a production deployment. Record the `CONTRACT_ID` and verification output from both runs in the deployment log.
