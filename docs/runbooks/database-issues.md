# Runbook: Database Connectivity Issues

**Linked alerts:** `DatabaseConnectionPoolExhausted`
**Severity:** P1

## Symptoms

- `DatabaseConnectionPoolExhausted` alert fires
- `db_pool_active_connections / db_pool_max_connections > 0.9`
- API responses are slow or returning 503
- Logs show `connection pool exhausted` or `timeout acquiring connection`

## Diagnosis

```bash
# 1. Check pool metrics in Prometheus
# db_pool_active_connections, db_pool_idle_connections, db_pool_waiting_count

# 2. Check DB circuit breaker state
# db_circuit_breaker_state (0=closed OK, 2=open = DB unreachable)

# 3. Check application logs
kubectl logs -l app=stellar-api | grep -E "pool|database|connection" | tail -50

# 4. Test direct DB connectivity
kubectl exec -it deploy/stellar-api -- \
  node -e "const { Pool } = require('pg'); const p = new Pool({connectionString: process.env.DATABASE_URL}); p.query('SELECT 1').then(() => console.log('OK')).catch(console.error)"
```

## Mitigation

### Pool exhaustion

1. Increase `DB_POOL_MAX` env var (default 10) if the database can support more connections.
2. Identify slow queries holding connections:
   ```sql
   SELECT pid, query, state, query_start FROM pg_stat_activity WHERE state != 'idle' ORDER BY query_start;
   ```
3. Terminate long-running blocking queries if safe.

### Circuit breaker open

1. The circuit breaker opens automatically after repeated failures and retries after the cooldown period.
2. If the database has recovered, the circuit breaker will close on its own.
3. If you need to force recovery, restart the API pod.

### Connection refused / unreachable

1. Verify `DATABASE_URL` env var is correct.
2. Check database server health (RDS console, pg_isready).
3. Check VPC/security group rules allow connections from app pods.

## Recovery Verification

```bash
# Circuit breaker should close
# Prometheus: db_circuit_breaker_state == 0

# Pool should have idle connections
# Prometheus: db_pool_idle_connections > 0
```
