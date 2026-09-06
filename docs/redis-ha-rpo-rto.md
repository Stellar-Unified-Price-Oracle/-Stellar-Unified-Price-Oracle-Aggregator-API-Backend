# Redis HA: RPO & RTO

## Architecture

The Redis HA setup uses Redis Sentinel to provide automatic failover with no
single point of failure.

```
                    ┌──────────────────────────────────────┐
                    │         Redis Sentinel Quorum         │
                    │  sentinel-0  sentinel-1  sentinel-2   │
                    │  (port 26379)                         │
                    └───────┬──────────────┬───────────────┘
                            │  monitors    │ votes (quorum=2)
                ┌───────────▼──────────────▼───────────────┐
                │                                           │
         ┌──────▼──────┐                    ┌──────────────▼──────┐
         │ redis-master │  async replication │  redis-replica-0    │
         │  (1 replica) │ ─────────────────▶ │  redis-replica-1    │
         │  port 6379   │                    │  (2 replicas)       │
         └─────────────┘                    └─────────────────────┘
```

### Components

- **1 master** (`redis-master-0`) — handles all writes; rate-limit counters and
  cache entries are written here first.
- **2 replicas** (`redis-replica-0`, `redis-replica-1`) — receive async
  replication from the master; can serve reads; promoted to master on failure.
- **3 sentinels** (`redis-sentinel-0/1/2`) — continuously monitor the master,
  detect failures, and coordinate failover by majority vote.

### Sentinel quorum

`quorum = 2`: at least 2 of the 3 sentinels must agree that the master is
unreachable before initiating a failover. This prevents split-brain promotions
from network partitions.

`down-after-milliseconds = 5000`: sentinels declare the master subjectively down
after 5 seconds of failed pings. Once quorum is reached, sentinel starts the
failover timer.

`failover-timeout = 60000`: maximum time allowed for a failover attempt is 60
seconds.

## RPO — Recovery Point Objective

**Near-zero (up to ~1 second data loss window).**

Redis replication is asynchronous. The master acknowledges writes to the client
before the replica confirms receipt. In the event of a sudden master failure:

- Data written and acknowledged **before** the last successful replication sync
  is preserved on the replica.
- Data written in the sub-second window between the last sync and the crash may
  be lost.

| State type        | RPO                                     |
|-------------------|-----------------------------------------|
| Cache entries     | Up to ~1 second (last replication sync) |
| Rate-limit state  | Up to ~1 second (last replication sync) |

A rate-limit window that was incremented in the <1s gap before failure will
reset on the new master, potentially allowing a brief extra burst from that
client. This is an acceptable trade-off for the availability guarantee.

For stricter RPO (zero data loss), enable `min-replicas-to-write 1` and
`min-replicas-max-lag 1` on the master, which blocks writes unless at least one
replica is in sync. This trades some write availability for durability.

## RTO — Recovery Time Objective

**~30 seconds (sentinel election + client reconnect).**

The failover timeline breaks down as:

| Phase | Duration |
|-------|----------|
| Sentinel detects master down (`down-after-milliseconds`) | ~5s |
| Quorum vote and failover decision | ~1–2s |
| Replica promotion and `REPLICAOF NO ONE` | ~1s |
| Other replicas repoint to new master | ~2s |
| Sentinel broadcasts new master address | ~1s |
| Client reconnect and discovery via Sentinel | ~5–15s |
| **Total** | **~15–30s** |

| State type        | RTO                          |
|-------------------|------------------------------|
| Cache entries     | ~30 seconds                  |
| Rate-limit state  | ~30 seconds                  |

During the failover window, write operations will fail. Clients using a
Sentinel-aware Redis client (e.g., `ioredis` with `sentinels` option) will
automatically reconnect to the new master after discovery. Read operations
against replicas may continue uninterrupted if the client supports replica
reads.

## Failover Procedure

### Automatic failover (Sentinel-managed)

No manual steps required. Sentinel handles promotion automatically when:

1. The master fails to respond to `PING` for `down-after-milliseconds` (5s).
2. At least `quorum` (2) sentinels agree the master is down.
3. One sentinel is elected leader and triggers `FAILOVER`.
4. The replica with the least replication lag is promoted.
5. All remaining replicas and sentinels are reconfigured to follow the new master.

### Manual failover

To force a failover (e.g., for maintenance):

```bash
# Connect to any sentinel and trigger graceful failover
redis-cli -p 26379 SENTINEL FAILOVER mymaster
```

### Verifying cluster state

```bash
# Check which node is current master
redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster

# Check sentinel view of master health
redis-cli -p 26379 SENTINEL masters

# Check replica lag
redis-cli -a "$REDIS_PASSWORD" INFO replication
```

### Reattaching a recovered old master

After the old master recovers, Sentinel automatically reconfigures it as a
replica of the new master. No manual steps are needed unless the node is
rejoining with stale data, in which case:

```bash
# Force replica sync (run on the recovered node)
redis-cli -a "$REDIS_PASSWORD" REPLICAOF <new-master-ip> 6379
```

## Testing Procedure

See [`scripts/test-redis-failover.sh`](../scripts/test-redis-failover.sh) for
the automated failover test.

The test:

1. Starts all 6 containers (master, 2 replicas, 3 sentinels) via
   `docker-compose.redis-ha.yml`.
2. Writes a rate-limit key to the master.
3. Kills the master container (`docker kill redis-master`).
4. Polls the sentinel for a new master address (max 30 seconds).
5. Attempts to read the key from the promoted replica.
6. Prints `PASS` if a new master was elected and is writable within 30 seconds,
   or `FAIL` with a diagnostic message otherwise.

Run the test:

```bash
export REDIS_PASSWORD=your-password
./scripts/test-redis-failover.sh
```

Expected output on success:

```
[INFO] Starting Redis HA services...
[INFO] redis-master is healthy
[INFO] Sentinel quorum established
[INFO] Writing rate-limit key to master...
[INFO] Key verified on master
[INFO] Killing redis-master container to trigger failover...
[INFO] New master elected: redis-replica-1 (after 12s)
[PASS] FAILOVER SUCCEEDED — new master is writable within 30s
```

## Kubernetes Deployment Notes

- StatefulSets use `volumeClaimTemplates` so each pod gets its own persistent
  volume. Data survives pod restarts.
- Redis auth password is injected via `secretKeyRef` from the
  `redis-credentials` Secret (key: `password`). Create this secret before
  deploying:
  ```bash
  kubectl create secret generic redis-credentials \
    --namespace stellar-oracle-redis \
    --from-literal=password='<your-strong-password>'
  ```
- The `configmap.yaml` uses `$(REDIS_PASSWORD)` placeholders that are
  substituted by the `config-init` initContainer at pod start time, avoiding
  secrets in ConfigMap values.
- Resource limits: master `256Mi/500m`, replicas `128Mi/250m`,
  sentinels `64Mi/100m`.
- PrometheusRule alerts (`k8s/base/redis/prometheus-rule.yaml`) fire into the
  `monitoring` namespace and require `kube-prometheus` for scraping
  `redis_exporter` metrics.
