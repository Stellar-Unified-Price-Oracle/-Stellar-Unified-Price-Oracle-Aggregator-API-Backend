# Runbook: Soroban Contract Call Failures

**Linked alerts:** `ContractCallFailures`
**Severity:** P1

## Symptoms

- `ContractCallFailures` Prometheus alert fires
- `stellar_soroban_contract_calls_total{status="failed"}` counter increasing
- Logs contain `[Contract] submit_price <asset> — failed` or `simulation_failed`
- On-chain prices are not being updated despite the aggregator running

## Diagnosis

```bash
# 1. Check contract call metrics
# Prometheus: rate(stellar_soroban_contract_calls_total{status="failed"}[5m]) > 0

# 2. Review contract logs
kubectl logs -l app=stellar-aggregator | grep -E "\[Contract\]" | tail -50

# 3. Check Soroban RPC connectivity
curl -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":{}}'

# 4. Check admin account balance and sequence number
curl "https://horizon-testnet.stellar.org/accounts/<ADMIN_PUBLIC_KEY>" | jq '{sequence, balances}'

# 5. Check gas usage alerts
kubectl logs -l app=stellar-aggregator | grep "High gas usage"
```

## Common Failure Modes

### Simulation failed

- **Cause**: Contract logic rejected the submission (e.g., timestamp too old, duplicate submission, insufficient authority)
- **Action**: Check the `error` field in the log. If timestamp-related, verify NTP sync on aggregator. If authorization, verify `ADMIN_SECRET_KEY` env var.

### Account sequence number conflict

- **Cause**: Multiple concurrent submissions caused sequence number mismatch
- **Action**: This resolves automatically on the next poll cycle. If persistent, ensure only one aggregator instance is running.

### Insufficient XLM balance

- **Cause**: Admin account ran out of XLM for transaction fees
- **Action**: Fund the admin account:
  ```bash
  # Testnet
  curl "https://friendbot.stellar.org?addr=<ADMIN_PUBLIC_KEY>"
  # Mainnet: transfer XLM from treasury wallet
  ```

### High gas / fee spike

- **Cause**: Network congestion or a large simulation cost
- **Action**: Check `stellar_soroban_contract_gas_used` histogram in Grafana. If consistently high, increase the base fee in publisher config.

### RPC endpoint unreachable

- **Cause**: Soroban RPC node is down or unreachable
- **Action**: Check `SOROBAN_RPC_URL` env var. Switch to a backup RPC endpoint if available.

### Contract paused (`ContractPaused`, error code 29)

- **Cause**: An emergency pause proposal (issue #379) was approved and
  executed via multi-sig, halting `submit_price` and `submit_batch` in every
  region. Reads (`get_price`, `get_price_history`) keep serving cached data.
- **Action**: This is expected during a declared incident freeze — do not
  treat it as an aggregator bug. Confirm intent with the on-call lead, then
  follow the pause/unpause drill below.

## Emergency pause / unpause drill (issue #379)

The pause flag lives on the oracle contract itself (`is_paused` / the
`Pause`/`Unpause` multi-sig `ProposalAction`s in `contract.rs`), not in an
off-chain service, so it is inherently multi-region-consistent: every
region's aggregator reads the same on-chain flag on its normal poll cycle
and skips submission the moment it flips, with no separate coordination bus
to keep in sync.

**To pause (freeze submission across all regions):**

```bash
# 1. A signer creates the pause proposal
soroban contract invoke --id <CONTRACT_ID> --source <SIGNER_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- create_proposal --proposer <SIGNER_ADDRESS> --action '{"Pause":{}}'

# 2. Remaining signers approve until the multi-sig threshold is met
soroban contract invoke --id <CONTRACT_ID> --source <SIGNER_KEY_2> \
  ... -- approve_proposal --approver <SIGNER_ADDRESS_2> --proposal_id <ID>

# 3. Execute once threshold is met
soroban contract invoke --id <CONTRACT_ID> --source <SIGNER_KEY> \
  ... -- execute_proposal --proposal_id <ID>

# 4. Verify — every region should reject submissions within one poll cycle
soroban contract invoke --id <CONTRACT_ID> ... -- is_paused
```

**To unpause:** repeat the same create/approve/execute flow with
`{"Unpause":{}}` as the action.

**Drill cadence:** exercise this end-to-end on testnet at least once per
quarter, timing how long it takes every region's aggregator logs to show
submissions being skipped after `execute_proposal` — that duration should
not exceed one aggregator poll interval (`POLLING_INTERVAL_MS`).

## Recovery Verification

```bash
# Confirm successful calls are resuming
kubectl logs -l app=stellar-aggregator | grep "\[Contract\] submit_price" | grep "success" | tail -10

# Check on-chain contract state (via Stellar SDK or Stellar Expert)
```

## Related

- [oracle-source-down.md](oracle-source-down.md)
- [post-mortem-template.md](post-mortem-template.md)
