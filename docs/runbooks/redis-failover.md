# Runbook: Redis HA Failover

**Linked alerts:** `RedisDown`, `RedisSentinelNoQuorum`, `RedisReplicationLag`, `RedisMasterMissing`, `RedisRateStateLost`
**Severity:** P0 / P1 (see per-alert severity)

## Symptoms

- `redis_up == 0`, or Sentinel reports no healthy master
- Sentinel quorum lost (fewer than 2 sentinels in OK state)
- Master has zero connected replicas, or rate-limit keyspace appears empty

## Diagnosis

1. Check pod and Sentinel health:

```bash
kubectl -n stellar-oracle get pods -l app.kubernetes.io/component=redis
kubectl -n stellar-oracle exec redis-sentinel-0 -- redis-cli -p 26379 sentinel master mymaster
kubectl -n stellar-oracle exec redis-0 -- redis-cli info replication
```

2. Confirm whether a failover is already in progress and which node was promoted.
3. Review the full procedure in `docs/redis-ha-rpo-rto.md#failover-procedure`.

## Mitigation

1. If quorum is lost, restore sentinel pod health first — automatic failover cannot proceed otherwise.
2. If no master is elected, trigger a controlled failover once quorum is back.
3. If rate-limit/cache state was lost after a failover, expect reset rate-limit windows and cache warm-up; no data-repair action is required.

## Recovery Verification

- `redis_sentinel_masters{status="ok"} == 1` and a healthy master is promoted
- Replication re-established (`redis_connected_slaves >= 1`)
- Cache hit ratio and rate limiting return to normal

## Related runbooks

- [database-issues.md](database-issues.md)
- [rollback-decision-tree.md](rollback-decision-tree.md)
