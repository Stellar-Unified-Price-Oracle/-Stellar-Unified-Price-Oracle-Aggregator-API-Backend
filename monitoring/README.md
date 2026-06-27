# Stellar Oracle Monitoring & Alerting

This directory contains Prometheus alerting rules and a Grafana dashboard for monitoring the Stellar Unified Price Oracle infrastructure.

## Components

### 1. Prometheus Alerting Rules (`prometheus-rules.yml`)

Pre-configured alerting rules that monitor critical aspects of the oracle system:

#### Critical Alerts
- **OracleSourceDowntime**: Triggers when an oracle source is down for > 60 seconds
- **NoOracleSourcesHealthy**: Triggers when all oracle sources become unhealthy simultaneously
- **HighErrorRate**: Triggers when 5xx error rate exceeds 5% for > 5 minutes
- **ContractCallFailures**: Triggers when Soroban contract calls fail

#### Warning Alerts
- **SourceHealthDegraded**: Triggers when a source has > 30% failure rate for > 5 minutes
- **CacheHitRatioCritical**: Triggers when cache hit ratio drops below 50% for > 5 minutes
- **PriceFeedStale**: Triggers when price hasn't been updated for > 120 seconds
- **PriceDeviation**: Triggers when price deviation exceeds 10%
- **APILatencyHigh**: Triggers when p95 latency exceeds 1 second for > 5 minutes
- **DatabaseConnectionPoolExhausted**: Triggers when > 90% of DB connections are in use

### 2. Grafana Dashboard (`grafana-dashboard.json`)

Comprehensive dashboard showing:

#### Key Metrics
- **Oracle Source Health Status**: Pie chart showing health distribution across sources (Chainlink, Redstone, Band, Reflector)
- **Aggregator Service Status**: Real-time up/down status with color coding
- **API Request Latency Percentiles**: p50, p95, p99 latency trends over time
- **Cache Performance**: Cache hit ratio trend with threshold indicators
- **24-Hour Asset Price Visualization**: Historical price data for XLM, BTC, ETH, USDC, USDT
- **API Request Rate**: Request throughput by method and path
- **Error Rate**: Real-time error percentage (5xx responses)
- **p95 Latency**: 95th percentile request latency in seconds
- **Cache Hit Ratio**: Percentage of cache hits vs misses
- **Oracle Source Success Rate**: Success percentage for each oracle source

## Installation

### Prerequisites
- Prometheus server (v2.0+)
- Grafana (v8.0+)
- Prometheus client libraries in your applications

### Step 1: Configure Prometheus

1. Copy `prometheus-rules.yml` to your Prometheus configuration directory:
```bash
cp monitoring/prometheus-rules.yml /etc/prometheus/rules/
```

2. Update your `prometheus.yml` to include the alerting rules:
```yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s

alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - 'localhost:9093'

rule_files:
  - '/etc/prometheus/rules/prometheus-rules.yml'

scrape_configs:
  - job_name: 'stellar-aggregator'
    static_configs:
      - targets: ['localhost:4000']
    metrics_path: '/metrics'

  - job_name: 'stellar-api'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
```

3. Restart Prometheus:
```bash
systemctl restart prometheus
# or
docker-compose restart prometheus
```

### Step 2: Import Grafana Dashboard

1. Log into Grafana (typically http://localhost:3000)
2. Navigate to **Dashboards** → **Import**
3. Click **Upload Dashboard JSON**
4. Select `monitoring/grafana-dashboard.json`
5. Select Prometheus as the data source
6. Click **Import**

Alternatively, use the Grafana API:
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d @monitoring/grafana-dashboard.json \
  http://localhost:3000/api/dashboards/db
```

### Step 3: Configure Alerting

Ensure Alertmanager is running and has been notified by Prometheus. Configure notification channels (email, Slack, PagerDuty, etc.) in Alertmanager.

Example Alertmanager config (`alertmanager.yml`):
```yaml
global:
  resolve_timeout: 5m
  slack_api_url: 'YOUR_SLACK_WEBHOOK_URL'

route:
  receiver: 'slack'
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h

receivers:
  - name: 'slack'
    slack_configs:
      - channel: '#oracle-alerts'
        title: 'Stellar Oracle Alert'
        text: '{{ .GroupLabels.alertname }}: {{ .Alerts | len }} alerts'
```

## Metrics

The system expects the following metrics to be exposed by your applications:

### Aggregator Service Metrics
- `stellar_oracle_source_healthy` (gauge): 1 if source is healthy, 0 otherwise
- `stellar_oracle_source_successes_total` (counter): Total successful polls per source
- `stellar_oracle_source_failures_total` (counter): Total failed polls per source
- `stellar_oracle_price{asset}` (gauge): Latest price for each asset
- `stellar_oracle_price_timestamp{asset}` (gauge): Timestamp of last price update
- `stellar_soroban_contract_calls_failed_total` (counter): Failed contract call attempts
- `stellar_db_pool_active_connections` (gauge): Currently active DB connections
- `stellar_db_pool_max_connections` (gauge): Maximum DB connection pool size

### API Service Metrics
- `stellar_api_requests_total` (counter): Total API requests by method/path/status
- `stellar_api_request_duration_seconds` (histogram): Request latency distribution
- `cache_hits_total` (counter): Total cache hits
- `cache_misses_total` (counter): Total cache misses
- `up` (gauge): Service health (1=up, 0=down)

## Testing Alerts

To test if alerts are working:

1. Simulate an oracle source being down:
```bash
# Stop the aggregator service or block network access
docker-compose stop aggregator
# Wait > 60 seconds
# Verify OracleSourceDowntime alert fires
```

2. Simulate high API latency:
```bash
# Add artificial delay in API responses
# or load-test the API
ab -n 10000 -c 100 http://localhost:3000/api/v1/prices
# Verify APILatencyHigh alert fires
```

3. Monitor the Grafana dashboard for real-time changes

## Dashboard Customization

The dashboard can be modified to add custom panels or adjust thresholds:

1. Open the dashboard in Grafana
2. Click the gear icon → **Edit**
3. Add/modify panels as needed
4. Save the dashboard
5. Export the modified dashboard JSON for version control

## Troubleshooting

### Alerts not firing
- Verify Prometheus is scraping metrics correctly: `http://localhost:9090/targets`
- Check rule evaluation: `http://localhost:9090/alerts`
- Review Prometheus logs for errors

### Missing metrics
- Ensure your services are exposing metrics at `/metrics` endpoint
- Verify metric names match those in dashboard and alert rules
- Check Prometheus scrape configs point to correct endpoints

### Dashboard showing no data
- Verify metrics are being collected: `http://localhost:9090/graph`
- Check time range in Grafana (top right corner)
- Ensure Prometheus data source is properly configured

## Documentation

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [Alertmanager Documentation](https://prometheus.io/docs/alerting/alertmanager/)

## Contributing

To contribute improvements to the monitoring setup:

1. Test alert rules and dashboard changes locally
2. Document any new metrics required
3. Update this README with new alerts/metrics
4. Create a pull request with changes
