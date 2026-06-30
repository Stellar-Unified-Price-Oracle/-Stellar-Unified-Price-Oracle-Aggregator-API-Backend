# Game Days

Game days are scheduled chaos sessions where the team observes system behavior under controlled failure.

## Cadence

- **Automated**: Every Sunday 03:00 UTC (serial workflow via Chaos Mesh Schedule)
- **Manual**: Quarterly deep-dive with extended experiments and live observation

## Pre-game checklist

- [ ] Confirm `CHAOS_TARGET_ENV=staging`
- [ ] Verify namespace label: `kubectl get ns stellar-oracle -L environment`
- [ ] Notify `#stellar-oracle-ops` with start/end window
- [ ] Open Grafana dashboards for API latency, error rate, and oracle source health
- [ ] Assign roles: **facilitator**, **observer**, **rollback owner**
- [ ] Review [rollback.md](rollback.md)

## During the game day

1. Facilitator confirms staging guard passed in workflow CronJob logs
2. Observers watch:
   - `/api/v1/health` availability
   - WebSocket reconnect behavior
   - Aggregator poll loop recovery
   - Price staleness alerts
3. Record timestamps for each experiment phase
4. Do not proceed to the next manual experiment until the previous SLO window clears

## Post-game

- Run `./scripts/chaos/generate-report.sh reports/game-day-$(date +%Y%m%d).md`
- Complete [incident-review.md](incident-review.md) for any unexpected behavior
- File issues for gaps discovered during the session

## Manual experiment order

When running outside the automated schedule, execute in this order:

1. pod-kill-api
2. pod-kill-aggregator
3. network-latency
4. network-partition
5. dns-failure
6. packet-loss
7. cpu-stress
8. memory-stress
9. node-failure

Allow at least 10 minutes between experiments for metrics to stabilize.
