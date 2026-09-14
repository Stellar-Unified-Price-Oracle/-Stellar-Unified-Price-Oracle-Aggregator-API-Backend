# Runbook: On-Chain Contract Upgraded

**Linked alert:** `OnChainContractUpgraded`
**Severity:** P0 (security-routed)

## Symptoms

- `onchain_upgrade_events_total` increases within a 10 m window
- An `upgraded` event was emitted with a new WASM hash `{{ $labels.to_hash }}`
- Alert routes to `security`

## Diagnosis

1. Verify the new WASM hash matches an approved release (see the contract upgrade governance process).
2. Confirm the upgrade was executed through the multi-sig/timelock flow and that the ABI/version stamp is expected.
3. If the hash is unknown, treat the upgrade as unauthorized and escalate immediately.

```bash
# Confirm the deployed hash and contract version
curl -s "$SOROBAN_RPC_URL" -X POST -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'
kubectl logs -l app=stellar-aggregator --tail=200 | grep -i "upgrade"
```

## Mitigation

### Approved upgrade

1. Record hash, proposal id, and verification status in the change log.
2. Monitor price submission success and staleness metrics until the new version is confirmed stable.

### Unapproved upgrade

1. Page the security on-call and open a security incident.
2. Pause submissions if integrity is in doubt and follow the rollback path in [rollback-decision-tree.md](rollback-decision-tree.md).
3. Rotate admin signer keys per the key-custody policy.

## Recovery Verification

- Price submissions succeed against the upgraded contract (`onchain_price_submissions_total` increasing)
- On-chain price staleness is within target
- Incident record closed with the approved hash documented

## Related runbooks

- [contract-failures.md](contract-failures.md)
- [rollback-decision-tree.md](rollback-decision-tree.md)
