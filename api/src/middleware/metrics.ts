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
