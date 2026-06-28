import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

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

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

export function metricsHandler(_req: Request, res: Response): void {
  res.set('Content-Type', register.contentType);
  register.metrics().then((data) => res.send(data));
}

export { register };
