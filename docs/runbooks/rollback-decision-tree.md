# Runbook: Rollback Decision Tree

**Severity:** P0–P1 (varies by path)

This document defines when to freeze, roll back, or roll forward, the decision criteria for each, the steps to execute each path, and the time-to-recovery (TTR) targets.

---

## Decision Tree

```
Incident detected (alert, on-call page, or manual observation)
│
├─► Is the system actively writing bad/corrupted state on-chain or to the DB?
│   YES ──► FREEZE immediately (< 2 min target), then re-evaluate below
│   NO  ──► Continue
│
├─► Was a deployment made in the last 30 minutes?
│   YES ──► Did error rate or staleness start after the deploy?
│   │        YES ──► ROLLBACK to previous image (< 10 min target)
│   │        NO  ──► Treat as operational incident; see relevant runbook
│   NO  ──► Continue
│
├─► Is there a known fix ready (hotfix branch or patch commit)?
│   YES ──► ROLL FORWARD with hotfix (< 30 min target)
│   NO  ──► ROLLBACK to last known-good image (< 10 min target)
│
└─► If none of the above resolves the incident, escalate to P0 disaster recovery:
    see disaster-recovery.md
```

---

## Signal Thresholds

### Signals that trigger FREEZE

Stop writes immediately when any of the following are true:

| Signal | Threshold | Source |
|--------|-----------|--------|
| On-chain prices contain impossible values | `price <= 0` OR `decimals` mismatch | Soroban contract events |
| DB corruption detected | Rows with `price <= 0` or `timestamp <= 0` | `price_history` table |
| Admin key suspected compromised | Any unauthorized `submit_price` transaction | On-chain tx history |
| Aggregator submitting prices outside ±50% of all-source median | Sustained >2 poll cycles | Prometheus `stellar_oracle_anomaly_score > 2.0` |

Freeze command (scales aggregator to 0 replicas, stops all on-chain writes):

```bash
./scripts/rollback.sh <env> --freeze-only
# or manually:
kubectl scale deployment/aggregator --replicas=0 -n stellar-oracle-<env>
```

### Signals that trigger ROLLBACK

Roll back to the previous image when:

| Signal | Threshold | Source |
|--------|-----------|--------|
| API 5xx error rate | >5% over 5 minutes after a deploy | Prometheus `HighErrorRate` alert |
| Price feed staleness (API cache) | >120 s for any tracked asset after a deploy | `PriceFeedStale` alert |
| On-chain heartbeat staleness | `onchain_price_staleness_seconds` > `STALENESS_THRESHOLD_MS` after a deploy | Aggregator `/health` → `onChainHeartbeat` |
| API p95 latency | >1 s sustained after a deploy | Prometheus `APILatencyHigh` alert |
| Aggregator crash-looping | >3 restarts in 5 minutes after a deploy | `kubectl get pods` → RESTARTS column |
| Health endpoint non-200 | `/api/v1/health` returns non-200 for >60 s after a deploy | Synthetic monitor |

Rollback command:

```bash
./scripts/rollback.sh <env>              # rolls back to HEAD~1
./scripts/rollback.sh <env> <commit-sha> # rolls back to a specific commit
```

### Signals that trigger ROLL FORWARD

Deploy a hotfix instead of rolling back when:

- The previous image also has the defect (regression introduced >1 commit ago).
- Rolling back would reintroduce a different known security or data-integrity bug.
- A targeted one-line fix is already merged and tested on a hotfix branch.
- The Soroban contract must be redeployed (contracts are immutable; you cannot roll back on-chain state, only deploy a new version).

Roll-forward command:

```bash
# Build and tag the hotfix
IMAGE_TAG="sha-$(git rev-parse --short HEAD)"
make build-aggregator build-api

# Deploy the hotfix image
bash scripts/deploy-k8s.sh <env> \
  "ghcr.io/<org>/stellar-oracle/api:${IMAGE_TAG}" \
  "ghcr.io/<org>/stellar-oracle/aggregator:${IMAGE_TAG}"
```

---

## Path Details

### Path A: Freeze

**TTR target: < 2 minutes**

1. Scale aggregator to 0 to stop all on-chain writes and source polling:
   ```bash
   kubectl scale deployment/aggregator --replicas=0 -n stellar-oracle-<env>
   ```
2. Record the freeze timestamp:
   ```bash
   echo "FREEZE $(date -u +%Y-%m-%dT%H:%M:%SZ) env=<env>" | tee -a logs/rollback-events.log
   ```
3. Verify no new submissions are landing on-chain (wait one `STALENESS_THRESHOLD_MS` window and check Soroban events).
4. Preserve pod logs before any restart:
   ```bash
   kubectl logs deployment/aggregator -n stellar-oracle-<env> > logs/aggregator-pre-freeze.log
   ```
5. Diagnose the root cause. Choose Path B or Path C once the cause is understood.

One-command invocation:

```bash
./scripts/rollback.sh staging --freeze-only
```

---

### Path B: Rollback

**TTR target: < 10 minutes**

1. Freeze (Path A step 1) is automatically performed by `rollback.sh` as its first step.
2. Identify the rollback target SHA (default: `HEAD~1`, or supply explicitly).
3. Resolve image tags for that SHA:
   ```
   ghcr.io/<org>/stellar-oracle/api:sha-<short-sha>
   ghcr.io/<org>/stellar-oracle/aggregator:sha-<short-sha>
   ```
4. Apply via kustomize:
   ```bash
   bash scripts/deploy-k8s.sh <env> <api-image> <aggregator-image>
   ```
5. Wait for rollout (120 s timeout):
   ```bash
   kubectl rollout status deployment/api deployment/aggregator \
     -n stellar-oracle-<env> --timeout=120s
   ```
6. Verify health endpoint returns 200:
   ```bash
   curl -sf http://<api-host>/api/v1/health
   ```
7. Re-enable aggregator (it is re-enabled by the deployment; confirm `replicas=1` in the new manifest).

One-command invocation:

```bash
./scripts/rollback.sh staging                  # previous commit
./scripts/rollback.sh staging abc1234          # specific SHA
CONFIRM_PRODUCTION=yes ./scripts/rollback.sh production abc1234
```

---

### Path C: Roll Forward

**TTR target: < 30 minutes**

1. Freeze (Path A step 1) while preparing the hotfix.
2. Create or identify the hotfix commit on a branch off `main`:
   ```bash
   git checkout -b hotfix/<issue> main
   # apply fix, commit, push
   ```
3. CI builds and pushes the image automatically on push. Wait for the build to complete or build locally:
   ```bash
   make build-aggregator build-api
   docker build -t ghcr.io/<org>/stellar-oracle/api:hotfix-<sha> api/
   docker push ghcr.io/<org>/stellar-oracle/api:hotfix-<sha>
   ```
4. Deploy to the affected environment:
   ```bash
   bash scripts/deploy-k8s.sh <env> \
     "ghcr.io/<org>/stellar-oracle/api:hotfix-<sha>" \
     "ghcr.io/<org>/stellar-oracle/aggregator:hotfix-<sha>"
   ```
5. Verify rollout and health (same as Path B steps 5–6).
6. Open a post-mortem issue referencing the freeze timestamp and TTR.

If the Soroban contract itself must be redeployed:

```bash
node scripts/deploy-soroban.js          # testnet/staging
node scripts/deploy-soroban.js --mainnet  # mainnet (requires ADMIN_SECRET_KEY)
```

Then update `CONTRACT_ID` in the environment config and restart the aggregator.

---

## TTR Targets Summary

| Path | Target TTR | Clock starts | Clock ends |
|------|-----------|--------------|------------|
| Freeze | < 2 min | Decision to freeze | `aggregator` scaled to 0, confirmed |
| Rollback | < 10 min | Decision to roll back | `/health` returns 200 on rolled-back image |
| Roll Forward | < 30 min | Decision to roll forward | `/health` returns 200 on hotfix image |

TTR is recorded automatically by `scripts/rollback.sh` and logged to `logs/rollback-events.log`.

---

## Related Runbooks

- [disaster-recovery.md](disaster-recovery.md) — database restore, key compromise, data corruption
- [high-error-rate.md](high-error-rate.md) — API 5xx investigation
- [price-feed-stale.md](price-feed-stale.md) — staleness diagnosis
- [price-anomaly.md](price-anomaly.md) — anomaly detection and source exclusion
- [contract-failures.md](contract-failures.md) — Soroban contract issues
