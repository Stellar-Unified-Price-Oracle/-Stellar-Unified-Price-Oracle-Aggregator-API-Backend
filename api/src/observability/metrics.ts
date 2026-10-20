import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const serviceStartupDurationMs = new client.Gauge({
  name: 'service_startup_duration_ms',
  help: 'Time from process startup until the service accepts ready traffic',
  labelNames: ['service'],
});
register.registerMetric(serviceStartupDurationMs);

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});
register.registerMetric(httpRequestDuration);

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
register.registerMetric(httpRequestsTotal);

export const priceQueriesTotal = new client.Counter({
  name: 'price_queries_total',
  help: 'Total number of price queries by asset',
  labelNames: ['asset'],
});
register.registerMetric(priceQueriesTotal);

export const cacheHitTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
});
register.registerMetric(cacheHitTotal);

export const cacheMissTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
});
register.registerMetric(cacheMissTotal);

export const lastPriceTimestamp = new client.Gauge({
  name: 'last_price_timestamp_seconds',
  help: 'Timestamp of the last price update per asset',
  labelNames: ['asset'],
});
register.registerMetric(lastPriceTimestamp);

export const circuitBreakerTriggered = new client.Counter({
  name: 'circuit_breaker_triggered_total',
  help: 'Total number of circuit breaker triggers by source and asset',
  labelNames: ['source', 'asset'],
});
register.registerMetric(circuitBreakerTriggered);

export const circuitBreakerActive = new client.Gauge({
  name: 'circuit_breaker_active',
  help: 'Number of active circuit breakers',
});
register.registerMetric(circuitBreakerActive);

export const priceDeviation = new client.Histogram({
  name: 'price_deviation_percent',
  help: 'Price deviation from median in percentage',
  labelNames: ['source', 'asset'],
  buckets: [1, 5, 10, 20, 30, 50, 100],
});
register.registerMetric(priceDeviation);

// ── Database connection pool & resilience (issues #44, #45) ──────────────────

export const dbPoolTotalConnections = new client.Gauge({
  name: 'db_pool_total_connections',
  help: 'Total connections in the pool (in use + idle)',
  labelNames: ['pool'],
});
register.registerMetric(dbPoolTotalConnections);

export const dbPoolIdleConnections = new client.Gauge({
  name: 'db_pool_idle_connections',
  help: 'Idle connections available in the pool',
  labelNames: ['pool'],
});
register.registerMetric(dbPoolIdleConnections);

export const dbPoolWaitingCount = new client.Gauge({
  name: 'db_pool_waiting_count',
  help: 'Number of queued requests waiting for a connection',
  labelNames: ['pool'],
});
register.registerMetric(dbPoolWaitingCount);

export const dbPoolMaxConnections = new client.Gauge({
  name: 'db_pool_max_connections',
  help: 'Configured maximum pool size',
  labelNames: ['pool'],
});
register.registerMetric(dbPoolMaxConnections);

export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['pool', 'operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});
register.registerMetric(dbQueryDuration);

export const dbQueryErrorsTotal = new client.Counter({
  name: 'db_query_errors_total',
  help: 'Total number of failed database queries',
  labelNames: ['pool', 'operation'],
});
register.registerMetric(dbQueryErrorsTotal);

export const dbRetriesTotal = new client.Counter({
  name: 'db_retries_total',
  help: 'Total number of database query retries',
  labelNames: ['pool'],
});
register.registerMetric(dbRetriesTotal);

export const dbCircuitBreakerState = new client.Gauge({
  name: 'db_circuit_breaker_state',
  help: 'Database circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['pool'],
});
register.registerMetric(dbCircuitBreakerState);

export const dbReplicaHealthy = new client.Gauge({
  name: 'db_replica_healthy',
  help: 'Read replica health (1=healthy, 0=unhealthy)',
  labelNames: ['replica'],
});
register.registerMetric(dbReplicaHealthy);

export const dbReplicaLagSeconds = new client.Gauge({
  name: 'db_replica_lag_seconds',
  help: 'Estimated read replica replication lag in seconds',
  labelNames: ['replica'],
});
register.registerMetric(dbReplicaLagSeconds);

export const dbRecordsArchivedTotal = new client.Counter({
  name: 'db_records_archived_total',
  help: 'Total number of price records archived to cold storage',
});
register.registerMetric(dbRecordsArchivedTotal);

// ── WebSocket connection analytics (issue #63) ───────────────────────────────

export const wsConnectionsActive = new client.Gauge({
  name: 'ws_api_connections_active',
  help: 'Current number of active WebSocket connections on the API server',
});
register.registerMetric(wsConnectionsActive);

export const wsConnectionsTotal = new client.Counter({
  name: 'ws_api_connections_total',
  help: 'Total WebSocket connections ever established on the API server',
});
register.registerMetric(wsConnectionsTotal);

export const wsMessagesTotal = new client.Counter({
  name: 'ws_api_messages_total',
  help: 'Total WebSocket messages on the API server',
  labelNames: ['direction', 'type'],
});
register.registerMetric(wsMessagesTotal);

export const wsConnectionDuration = new client.Histogram({
  name: 'ws_api_connection_duration_seconds',
  help: 'Duration of API WebSocket connections in seconds',
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
});
register.registerMetric(wsConnectionDuration);

export const wsErrorsTotal = new client.Counter({
  name: 'ws_api_errors_total',
  help: 'Total WebSocket errors on the API server',
});
register.registerMetric(wsErrorsTotal);

export const wsSubscribeEventsTotal = new client.Counter({
  name: 'ws_api_subscribe_events_total',
  help: 'Total subscribe/unsubscribe events on the API WebSocket server',
  labelNames: ['action'],
});
register.registerMetric(wsSubscribeEventsTotal);

// ── WebSocket replay bounding (issue #606) ───────────────────────────────────

export const wsReplayTotal = new client.Counter({
  name: 'ws_api_replay_requests_total',
  help: 'Total replay requests by outcome: complete, truncated or rate_limited',
  labelNames: ['result'],
});
register.registerMetric(wsReplayTotal);

export const wsBufferedAssets = new client.Gauge({
  name: 'ws_api_buffered_assets',
  help: 'Number of assets currently holding a replay buffer',
});
register.registerMetric(wsBufferedAssets);

export const wsBufferBytes = new client.Gauge({
  name: 'ws_api_buffer_bytes',
  help: 'Approximate bytes retained across all replay buffers',
});
register.registerMetric(wsBufferBytes);

// ── GraphQL preview surface (issue #607) ─────────────────────────────────────

export const graphqlRequestsTotal = new client.Counter({
  name: 'graphql_requests_total',
  help: 'Total GraphQL requests by outcome: success, error, rejected, timeout, disabled, tier_forbidden',
  labelNames: ['result'],
});
register.registerMetric(graphqlRequestsTotal);

// ── Audit chain integrity (issue #598) ───────────────────────────────────────

export const auditEventsTotal = new client.Counter({
  name: 'audit_events_total',
  help: 'Total audit events by outcome: appended or refused',
  labelNames: ['result'],
});
register.registerMetric(auditEventsTotal);

export const auditChainValid = new client.Gauge({
  name: 'audit_chain_valid',
  help: '1 when the audit log chain is verifiable, 0 after a break or fork',
});
register.registerMetric(auditChainValid);

export const auditChainVerificationTotal = new client.Counter({
  name: 'audit_chain_verifications_total',
  help: 'Total audit chain verifications by result: passed, failed, forked or error',
  labelNames: ['result'],
});
register.registerMetric(auditChainVerificationTotal);

export const apiCallsByEndpoint = new client.Counter({
  name: 'api_calls_by_endpoint_total',
  help: 'Total API calls grouped by endpoint, method, and status',
  labelNames: ['endpoint', 'method', 'status'],
});
register.registerMetric(apiCallsByEndpoint);

export const rateLimitDecisionsTotal = new client.Counter({
  name: 'rate_limit_decisions_total',
  help: 'Rate limit decisions by layer, tenant, endpoint, and result',
  labelNames: ['layer', 'tenant', 'endpoint', 'result'],
});
register.registerMetric(rateLimitDecisionsTotal);

export const rateLimitCounterSize = new client.Gauge({
  name: 'rate_limit_counter_size',
  help: 'Number of active local rate limit counters',
});
register.registerMetric(rateLimitCounterSize);

export const rateLimitRedisLatency = new client.Histogram({
  name: 'rate_limit_redis_latency_seconds',
  help: 'Redis latency for distributed rate limit counter updates',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05],
});
register.registerMetric(rateLimitRedisLatency);

export const rbacDeniedTotal = new client.Counter({
  name: 'rbac_denied_total',
  help: 'Authorization denials on admin/governance routes by role, route, and reason',
  labelNames: ['role', 'route', 'reason'],
});
register.registerMetric(rbacDeniedTotal);

export const pipelineStageLatencyMs = new client.Histogram({
  name: 'pipeline_stage_latency_ms',
  help: 'Latency budget for each stage of the price pipeline in milliseconds',
  labelNames: ['stage', 'status'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});
register.registerMetric(pipelineStageLatencyMs);

export const historyFileReadFailuresTotal = new client.Counter({
  name: 'api_history_file_read_failures_total',
  help: 'Total history file read failures by reason (unreadable, undecryptable, malformed)',
  labelNames: ['asset', 'reason'],
});
register.registerMetric(historyFileReadFailuresTotal);

export const auditAppendsTotal = new client.Counter({
  name: 'audit_log_appends_total',
  help: 'Total audit log append attempts by outcome',
  labelNames: ['status'],
});
register.registerMetric(auditAppendsTotal);

export const auditAppendDuration = new client.Histogram({
  name: 'audit_log_append_duration_seconds',
  help: 'Wall-clock cost of appending a single audit entry (issue #599 measured this before and after)',
  labelNames: ['status'],
  buckets: [0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
});
register.registerMetric(auditAppendDuration);

export const auditRetentionRunsTotal = new client.Counter({
  name: 'audit_retention_runs_total',
  help: 'Total audit retention sweeps by outcome (completed, skipped, failed)',
  labelNames: ['status'],
});
register.registerMetric(auditRetentionRunsTotal);

export const auditRetentionFailuresTotal = new client.Counter({
  name: 'audit_retention_failures_total',
  help: 'Total audit retention sweeps that could not run, by failure reason',
  labelNames: ['reason'],
});
register.registerMetric(auditRetentionFailuresTotal);

export const auditEntriesArchivedTotal = new client.Counter({
  name: 'audit_entries_archived_total',
  help: 'Total audit entries moved out of the active log into the archive',
});
register.registerMetric(auditEntriesArchivedTotal);

// ── Per-feed replication lag & feed health routing (issues #739, #740) ───────

export const feedReplicationLagSeconds = new client.Histogram({
  name: 'feed_replication_lag_seconds',
  help: 'Replication lag per feed and region, measured as consumer-visible staleness',
  labelNames: ['feed', 'region'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
});
register.registerMetric(feedReplicationLagSeconds);

export const feedLastSequence = new client.Gauge({
  name: 'feed_last_sequence',
  help: 'Highest sequence number observed per feed and region',
  labelNames: ['feed', 'region'],
});
register.registerMetric(feedLastSequence);

export const feedMissingSequencesTotal = new client.Counter({
  name: 'feed_missing_sequences_total',
  help: 'Total sequence gaps detected per feed and region',
  labelNames: ['feed', 'region'],
});
register.registerMetric(feedMissingSequencesTotal);

export const feedLagThresholdExceeded = new client.Gauge({
  name: 'feed_lag_threshold_exceeded',
  help: '1 when a feed/region lag exceeds its consumer-impact threshold, 0 otherwise',
  labelNames: ['feed', 'region'],
});
register.registerMetric(feedLagThresholdExceeded);

export const feedHealthState = new client.Gauge({
  name: 'feed_health_state',
  help: 'Per-feed health state (0=unhealthy, 1=degraded, 2=healthy)',
  labelNames: ['feed', 'region'],
});
register.registerMetric(feedHealthState);

export const feedRoutingDecisionsTotal = new client.Counter({
  name: 'feed_routing_decisions_total',
  help: 'Consumer routing decisions by feed, chosen region and reason (fresh, degraded, failover)',
  labelNames: ['feed', 'region', 'reason'],
});
register.registerMetric(feedRoutingDecisionsTotal);

export const feedFailoversTotal = new client.Counter({
  name: 'feed_failovers_total',
  help: 'Deterministic failovers triggered by feed health signals',
  labelNames: ['feed', 'from_region', 'to_region'],
});
register.registerMetric(feedFailoversTotal);

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    apiCallsByEndpoint.inc({ endpoint: route, method: req.method, status: res.statusCode });
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

export function metricsHandler(_req: Request, res: Response): void {
  res.set('Content-Type', register.contentType);
  register.metrics().then((data) => res.send(data));
}

export { register };
