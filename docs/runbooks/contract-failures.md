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

## Recovery Verification

```bash
# Confirm successful calls are resuming
kubectl logs -l app=stellar-aggregator | grep "\[Contract\] submit_price" | grep "success" | tail -10

# Check on-chain contract state (via Stellar SDK or Stellar Expert)
```

## Related

- [oracle-source-down.md](oracle-source-down.md)
- [post-mortem-template.md](post-mortem-template.md)
