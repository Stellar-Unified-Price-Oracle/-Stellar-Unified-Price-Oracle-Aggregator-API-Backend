# Rollback and Abort Procedures

## Immediate abort

If chaos affects the wrong namespace or environment:

```bash
export CHAOS_TARGET_ENV=staging
kubectl -n stellar-oracle delete podchaos,networkchaos,stresschaos,dnschaos,workflows --all
kubectl -n stellar-oracle patch schedule weekly-chaos-schedule --type merge \
  -p '{"spec":{"suspend":true}}' 2>/dev/null || true
```

## Suspend weekly schedule

```bash
kubectl -n stellar-oracle patch schedule weekly-chaos-schedule \
  --type merge -p '{"spec":{"suspend":true}}'
```

Re-enable when ready:

```bash
kubectl -n stellar-oracle patch schedule weekly-chaos-schedule \
  --type merge -p '{"spec":{"suspend":false}}'
```

## Uninstall Chaos Mesh

```bash
helm uninstall chaos-mesh -n stellar-oracle
kubectl delete -k k8s/chaos --ignore-not-found
```

## Verify recovery

```bash
kubectl -n stellar-oracle get pods -l 'app in (api,aggregator)'
kubectl -n stellar-oracle get events --sort-by=.lastTimestamp | tail -20
curl -sf http://localhost:3000/api/v1/health
```

## Escalation

1. Suspend all experiments (above)
2. Notify `#stellar-oracle-ops`
3. If staging data is corrupted, redeploy from last known-good overlay
4. Document findings in [incident-review.md](incident-review.md)

## Pre-flight guard

Install and automation scripts refuse to run unless:

```bash
export CHAOS_TARGET_ENV=staging
```

The weekly resilience CronJob additionally verifies `environment=staging` on the namespace label.
