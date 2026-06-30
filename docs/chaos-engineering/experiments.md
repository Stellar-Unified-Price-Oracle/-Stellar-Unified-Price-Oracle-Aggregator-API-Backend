# Experiment objectives

Each experiment validates a specific resilience property of the Stellar Oracle staging stack.

| Experiment | Objective | Success criteria |
|------------|-----------|------------------|
| pod-kill-api | API pod recovery | Health endpoint returns 200 within 90s |
| pod-kill-aggregator | Aggregator pod recovery | Price updates resume within 120s |
| network-latency | Degraded inter-service latency | API remains available; p95 latency bounded |
| network-partition | Split-brain between API and aggregator | Graceful errors, no stale prices served |
| dns-failure | Oracle source DNS outage | Aggregator retries; circuit breaker engages |
| packet-loss | Egress packet loss | fetchWithBackoff recovers when loss clears |
| cpu-stress | API CPU pressure | HPA or limits prevent total outage |
| memory-stress | Aggregator memory pressure | OOMKill recovery without data corruption |
| node-failure | Simulated node outage | All pods reschedule and pass readiness |
