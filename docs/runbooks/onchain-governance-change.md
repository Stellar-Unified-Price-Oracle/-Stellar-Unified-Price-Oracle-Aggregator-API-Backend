# Runbook: On-Chain Governance Change

**Linked alert:** `OnChainGovernanceChange`
**Severity:** P1 (security-routed)

## Symptoms

- `onchain_governance_events_total` increases within a 10 m window
- A `{{ $labels.kind }}` governance event (signer/threshold/admin change) was emitted by the oracle contract
- Alert routes to `security`

## Diagnosis

1. Confirm the change is expected: check the approved governance proposal and its execution record.
2. Correlate the event with the deploy/ops change window and the on-chain transaction hash.
3. If the change is not tied to a known proposal, treat it as a possible key compromise.

```bash
# Governance activity and recent proposals
curl -s localhost:3000/api/v1/governance/proposals | jq '.data.proposals[-5:]'
kubectl logs -l app=stellar-aggregator --tail=200 | grep -i "governance"
```

## Mitigation

### Planned change

1. Record the proposal id, approver set, and execution hash in the change log.
2. No action required once the change matches an approved proposal.

### Unplanned change

1. Escalate immediately to the security on-call and open a security incident.
2. Use the governance/multi-sig flow to rotate or revoke the affected signer.
3. Follow the rollback path in [rollback-decision-tree.md](rollback-decision-tree.md) if the change affects price submissions.

## Recovery Verification

- No further unexpected `onchain_governance_events_total` increments
- Governance signer set and threshold match the intended configuration
- Incident record closed with root cause documented

## Related runbooks

- [rollback-decision-tree.md](rollback-decision-tree.md)
- [contract-failures.md](contract-failures.md)
