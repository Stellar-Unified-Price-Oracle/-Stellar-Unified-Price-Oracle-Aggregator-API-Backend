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

---

## Exiting brownout mode (#741)

Brownout mode sheds non-critical work while preserving explicit price freshness and
publication guarantees. It is controlled by the `BROWNOUT_MODE` flag and the
`BROWNOUT_SHED` allow-list. Owner: Global Operations and Resilience.

### When to exit

Exit brownout when the triggering condition has cleared and the following hold for
at least one full freshness window:

- `oracle_price_freshness_seconds` is within SLO for every published pair.
- `oracle_publication_lag_seconds` p99 is back under its threshold.
- Error budget burn rate is below the page threshold.

### Rollback steps

1. Re-enable shed work incrementally (never all at once):

   ```bash
   # Step 1: restore non-critical background jobs
   kubectl -n stellar-oracle set env deploy/aggregator BROWNOUT_SHED="exports,analytics"
   # Step 2: restore remaining shed work
   kubectl -n stellar-oracle set env deploy/aggregator BROWNOUT_SHED=""
   # Step 3: disable brownout mode entirely
   kubectl -n stellar-oracle set env deploy/aggregator BROWNOUT_MODE="off"
   ```

2. If freshness or publication regresses after any step, immediately re-enter
   brownout by reversing the last step:

   ```bash
   kubectl -n stellar-oracle set env deploy/aggregator BROWNOUT_MODE="on"
   ```

### Verification

```bash
# Confirm flag state
kubectl -n stellar-oracle get deploy/aggregator -o jsonpath='{.spec.template.spec.containers[0].env}'
# Confirm freshness and publication metrics recovered
curl -sf http://localhost:3000/api/v1/health | jq '.brownout'
curl -sf http://localhost:9090/api/v1/query \
  --data-urlencode 'query=oracle_price_freshness_seconds' | jq '.data.result'
```

### Rollout / rollback guidance

- Roll out brownout flags via the deployment overlay, not ad-hoc `kubectl set env`,
  in production. The commands above are the emergency path.
- Monitor `brownout_active`, `oracle_price_freshness_seconds`, and
  `oracle_publication_lag_seconds` dashboards during both entry and exit.
- Rollback of a brownout exit is always "re-enter brownout" — it is safe and
  idempotent.

---

## Aborting a regional maintenance window (#742)

Maintenance windows run a guarded workflow: prechecks → traffic drain → publisher
fencing → maintenance → post-validation. Owner: Global Operations and Resilience.

### Abort at any phase

The maintenance controller exposes an abort endpoint that reverses the current
phase safely. Abort is idempotent and safe to call from any phase.

```bash
# Abort the named window for a region
curl -sf -X POST http://localhost:3000/api/v1/maintenance/abort \
  -H 'content-type: application/json' \
  -d '{"region":"us-east-1","reason":"operator abort"}'
```

If the controller is unreachable, abort manually in reverse phase order:

1. **Unfence publishers** (if fenced):

   ```bash
   kubectl -n stellar-oracle label deploy/publisher \
     maintenance-fenced- --overwrite
   ```

2. **Restore traffic** (if drained):

   ```bash
   kubectl -n stellar-oracle patch service aggregator --type merge \
     -p '{"spec":{"selector":{"app":"aggregator"}}}'
   ```

3. **Clear the window record** so the scheduler does not resume a half-run window:

   ```bash
   kubectl -n stellar-oracle delete configmap maintenance-window-us-east-1 --ignore-not-found
   ```

### Verification

```bash
# Window state should be "aborted" or absent
curl -sf http://localhost:3000/api/v1/maintenance/status?region=us-east-1 | jq
# Publishers unfenced and serving
kubectl -n stellar-oracle get deploy/publisher -o jsonpath='{.metadata.labels}'
# Traffic restored
kubectl -n stellar-oracle get endpoints aggregator
# Freshness/publication intact
curl -sf http://localhost:3000/api/v1/health | jq '.maintenance, .freshness'
```

### Rollout / rollback guidance

- Enable maintenance automation per-region behind the `MAINTENANCE_AUTOMATION`
  flag; start with a single canary region.
- Monitor `maintenance_phase`, `maintenance_aborts_total`, and publisher fencing
  state during rollout.
- Rollback of the automation itself: set `MAINTENANCE_AUTOMATION=off`; any
  in-flight window must be aborted first using the steps above.

---

## Tenant-isolation failure response (#747)

Adversarial tenant-isolation tests run in CI across caches, REST, GraphQL,
WebSockets, exports, and background jobs. A failure means a tenant boundary may be
crossable. Owner: Security and Privacy Assurance.

### Immediate response

1. **Treat as a potential data-exposure incident.** Page the on-call security
   engineer and open an incident.
2. **Contain** by disabling the affected shared path if it can be isolated:

   ```bash
   # Example: disable cross-tenant export path
   kubectl -n stellar-oracle set env deploy/api TENANT_EXPORTS_ENABLED="false"
   ```

3. **Preserve evidence** — capture the failing test seed and request trace:

   ```bash
   pnpm test:fuzz:tenant -- --seed "$FAILING_SEED" --repro > tenant-repro.log
   ```

### Rollback steps

- If the regression was introduced by a recent deploy, roll back to the last
  known-good image:

  ```bash
  kubectl -n stellar-oracle rollout undo deploy/api
  kubectl -n stellar-oracle rollout status deploy/api
  ```

- Re-enable any contained path only after the fix is verified by the fuzz suite.

### Verification

```bash
# Full tenant-isolation fuzz suite must pass
pnpm test:fuzz:tenant
# Confirm no cross-tenant cache keys leaked
curl -sf http://localhost:3000/api/v1/health | jq '.tenant_isolation'
```

---

## Authorization regression failure response (#749)

The authorization regression corpus is a versioned matrix of allowed/denied
actions across roles, scopes, lifecycle states, and API versions, run in CI. A
failure means an action's allow/deny outcome changed unexpectedly. Owner: Security
and Privacy Assurance.

### Immediate response

1. **Do not merge** the change that broke the corpus. The CI gate blocks it.
2. Determine whether the change is an **intended** policy change or a **regression**:
   - Intended: update the corpus matrix in the same PR with reviewer sign-off.
   - Regression: revert the offending change.

### Rollback steps

```bash
# Revert the offending commit (or roll back the deploy)
git revert <offending-sha>
# If already deployed:
kubectl -n stellar-oracle rollout undo deploy/api
kubectl -n stellar-oracle rollout status deploy/api
```

### Verification

```bash
# Corpus must pass against the running build
pnpm test:authz:corpus
# Spot-check a denied action is still denied
curl -sf -o /dev/null -w '%{http_code}\n' \
  -H 'authorization: Bearer <low-scope-token>' \
  http://localhost:3000/api/v1/admin/tenants
# Expect 403
```

### Rollout / rollback guidance

- The corpus is versioned alongside the code; policy changes and matrix updates
  ship together.
- Monitor `authz_denied_total` and `authz_corpus_failures_total`; a spike in either
  after deploy warrants a rollback.
- Rollback of a policy change is a normal deploy rollback; the corpus re-runs
  automatically on the rolled-back build.
