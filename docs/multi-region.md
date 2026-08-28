# Active-active multi-region operation

The production topology runs independent API and aggregator stacks in `us-east-1`, `eu-west-1`, and `ap-southeast-1`. Each region is active and serves traffic through the global load balancer using latency-based routing and `/api/v1/health` checks every 5 seconds.

Price replication is asynchronous and local-first. Each regional aggregator publishes local aggregate prices to the cross-region Kafka mirror. Consumers store local and remote observations as last-writer-wins registers keyed by asset and region. The latest wall-clock timestamp wins, so regions converge without synchronous reads or consensus. The API always reads from local regional storage and may serve data up to the configured replication lag behind another region.

Operations thresholds are configured in `k8s/base/multi-region/geo-config.yaml`: replication p99 target `<5s`, drift alert threshold `10` bps, failover window `100ms`, and automatic quarantine enabled. A quarantined region remains available for internal health checks but is removed from production routing and stops publishing replicated prices until accuracy recovers.

Weekly staging DR drills run through the existing Chaos Mesh schedule in `k8s/chaos/schedules/weekly-chaos-schedule.yaml`; load testing uses the k6 scenarios under `load-tests/k6/` and should include a 50% regional traffic-loss run before production promotion.
