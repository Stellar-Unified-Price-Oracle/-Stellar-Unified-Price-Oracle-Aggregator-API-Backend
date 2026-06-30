import http from 'http';
import { logger } from './utils/logger';
import { withCorrelation, correlationHeaders } from './utils/correlation';
import { SourceCBStatus } from './source-circuit-breaker';

interface HealthSnapshot {
  sourceHealth: Record<string, any>;
  lastAggregated: any[];
  uptime: number;
  circuitBreakerMetrics?: any;
  circuitBreakerStates?: Record<string, SourceCBStatus>;
}

export class HealthServer {
  private server: http.Server | null = null;
  private port: number;
  private getSnapshot: () => HealthSnapshot;
  private startedAt = Date.now();

  constructor(port: number, getSnapshot: () => HealthSnapshot) {
    this.port = port;
    this.getSnapshot = getSnapshot;
  }

  start(): void {
    this.server = http.createServer((req, res) => {
      withCorrelation(req.headers, () => this.handleRequest(req, res));
    });

    this.server.listen(this.port, () => {
      logger.info(`Health server listening on port ${this.port}`);
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const verbose = url.searchParams.get('verbose') === 'true';
      const ids = correlationHeaders();
      res.setHeader('x-request-id', ids['x-request-id'] || '');
      res.setHeader('x-trace-id', ids['x-trace-id'] || '');

      if (url.pathname === '/health/live') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
        return;
      }

      if (url.pathname === '/health/ready') {
        const snap = this.getSnapshot();
        const openCircuits = snap.circuitBreakerStates
          ? Object.values(snap.circuitBreakerStates).filter((s) => s.state === 'OPEN')
          : [];
        const hasPrices = snap.lastAggregated.length > 0;
        const ready = hasPrices && openCircuits.length < Object.keys(snap.sourceHealth).length;
        const code = ready ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: ready ? 'ready' : 'not_ready',
          hasPrices,
          openCircuitBreakers: openCircuits.length,
        }));
        return;
      }

      if (url.pathname === '/health' || url.pathname === '/') {
        const snap = this.getSnapshot();
        const allHealthy = Object.values(snap.sourceHealth).every((s: any) => s.healthy);
        const someHealthy = Object.values(snap.sourceHealth).some((s: any) => s.healthy);
        const status = allHealthy ? 'healthy' : someHealthy ? 'degraded' : 'unhealthy';

        const body: Record<string, any> = {
          service: 'stellar-price-oracle-aggregator',
          status,
          uptime: snap.uptime,
          timestamp: Math.floor(Date.now() / 1000),
          sources: Object.entries(snap.sourceHealth).map(([name, h]: [string, any]) => ({
            name,
            healthy: h.healthy,
            consecutiveFailures: h.consecutiveFailures,
            uptimePercent: h.uptimePercent,
          })),
          circuitBreakers: snap.circuitBreakerStates
            ? Object.entries(snap.circuitBreakerStates).map(([name, s]) => ({
                source: name,
                state: s.state,
                totalTrips: s.totalTrips,
              }))
            : [],
        };

        if (verbose) {
          body.sourceHealth = snap.sourceHealth;
          body.circuitBreakerMetrics = snap.circuitBreakerMetrics;
          body.circuitBreakerStates = snap.circuitBreakerStates;
          body.lastAggregated = snap.lastAggregated;
          body.processMemoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          body.nodeVersion = process.version;
        }

        const httpStatus = status === 'unhealthy' ? 503 : 200;
        res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      res.writeHead(404);
      res.end();
  }

  stop(): void {
    this.server?.close();
  }
}
