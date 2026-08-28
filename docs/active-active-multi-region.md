# Active-active multi-region oracle deployment

The oracle supports an active-active topology across `us-east-1`, `eu-west-1`,
and `ap-southeast-1`. Each region runs its own API, aggregator, database, and
history storage. Requests are served from the local region only; cross-region
reads are intentionally asynchronous to keep API latency low.

## Routing and health

Use AWS Global Accelerator or Cloudflare Load Balancing with latency-based
routing. Health checks must call `/health` every 5 seconds and remove unhealthy
regions from rotation. The operational target is sub-100ms failover after the
load balancer observes a failed health check.

## Price replication

Each aggregator publishes local aggregated prices to the configured
`REGION_REPLICATION_TOPIC` on the cross-region Kafka/Pulsar bus. Consumers merge
remote records into a CRDT LWW register keyed by `region:asset`; the winner for
an asset is the record with the greatest aggregator timestamp. No synchronous
cross-region request path is required.

## Consistency model

Reads are local-first and eventually consistent. A region may serve stale data
until replication catches up. The bounded-staleness target is
`REGION_MAX_REPLICATION_LAG_MS` with a default p99 target of 5 seconds.

## Drift monitoring and quarantine

Aggregators compute cross-region drift from replicated prices. If drift exceeds
`REGION_DRIFT_ALERT_PERCENT` the region emits an alert. When
`REGION_QUARANTINE_ENABLED=true`, the region marks itself quarantined until
drift falls below `REGION_QUARANTINE_RECOVER_PERCENT`; load balancer health
configuration should stop routing production traffic to quarantined regions.

## Disaster recovery drills

The staging DR drill runs weekly through the chaos workflow. It should block
network traffic from one region, verify the other two regions continue serving
traffic, verify CRDT convergence after the partition is removed, and run the
load-test scenario that models 50% regional traffic loss.
