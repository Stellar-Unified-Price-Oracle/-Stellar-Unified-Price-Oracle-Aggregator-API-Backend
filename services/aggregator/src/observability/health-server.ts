import http from 'http';
import { logger } from './logger';
import { correlationHeaders } from '../infrastructure/correlation';
import { SourceCBStatus } from '../price-aggregation/source-circuit-breaker';
import { register } from './metrics';
import { getDailyCounts } from '../infrastructure/cost-model';
import { getUptimeHistory, getUptimeForPeriod, getLatestUptime } from '../persistence/uptime-history';
import type { SourceHealthStatus, AggregatedPrice } from '@stellar-oracle/types';
import type { RegionPriceRecord } from '../replication/price-crdt';

export interface CircuitBreakerMetrics {
  totalSources: number;
  suspiciousSources: number;
  suspiciousSourcesList: Array<{ key: string; deviations: number }>;
}

export interface HealthSnapshot {
  sourceHealth: Record<string, SourceHealthStatus>;
  lastAggregated: AggregatedPrice[];
  uptime: number;
  startupTimeMs?: number;
  region?: { region: string; quarantined: boolean; reason?: string };
  replicatedPrices?: RegionPriceRecord[];
  circuitBreakerMetrics?: CircuitBreakerMetrics;
  circuitBreakerStates?: Record<string, SourceCBStatus>;
  // Issue #382 — seconds since last on-chain update, per asset.
  onChainHeartbeat?: Record<string, number>;
}

export class HealthServer {
  private server: http.Server | null = null;
  private port: number;
  private getSnapshot: () => HealthSnapshot;

  constructor(port: number, getSnapshot: () => HealthSnapshot) {
    this.port = port;
    this.getSnapshot = getSnapshot;
  }

  start(): void {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const verbose = url.searchParams.get('verbose') === 'true';
      const ids = correlationHeaders();
      res.setHeader('x-request-id', ids['x-request-id'] || '');
      res.setHeader('x-trace-id', ids['x-trace-id'] || '');

      // #64 #65 — Prometheus metrics endpoint for aggregator
      if (url.pathname === '/metrics') {
        try {
          const metrics = await register.metrics();
          res.writeHead(200, { 'Content-Type': register.contentType });
          res.end(metrics);
        } catch {
          res.writeHead(500);
          res.end();
        }
        return;
      }

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
        const quarantined = snap.region?.quarantined === true;
        const ready = hasPrices && !quarantined && openCircuits.length < Object.keys(snap.sourceHealth).length;
        const code = ready ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: ready ? 'ready' : 'not_ready',
          hasPrices,
          quarantined,
          startupTimeMs: snap.startupTimeMs ?? 0,
          openCircuitBreakers: openCircuits.length,
        }));
        return;
      }

      // ── Uptime history query endpoints ──────────────────────────────
      const uptimeMatch = url.pathname.match(/^\/health\/uptime\/(\w+)$/);
      if (uptimeMatch) {
        const source = uptimeMatch[1];
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const limit = parseInt(url.searchParams.get('limit') || '720', 10);
        const window = url.searchParams.get('window');

        if (window) {
          const windowSeconds = parseInt(window, 10);
          const stats = getUptimeForPeriod(source, windowSeconds);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ source, ...stats }));
          return;
        }

        const history = getUptimeHistory(
          source,
          from ? parseInt(from, 10) : undefined,
          to ? parseInt(to, 10) : undefined,
          limit,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ source, history }));
        return;
      }

      if (url.pathname === '/health/uptime') {
        const snap = this.getSnapshot();
        const uptimeSummary = Object.entries(snap.sourceHealth).map(([name, h]) => ({
          source: name,
          current: {
            healthy: h.healthy,
            uptimePercent: h.uptimePercent,
            consecutiveFailures: h.consecutiveFailures,
          },
          latest: getLatestUptime(name),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sources: uptimeSummary }));
        return;
      }

      if (url.pathname === '/health' || url.pathname === '/') {
        const snap = this.getSnapshot();
        const allHealthy = Object.values(snap.sourceHealth).every((s) => s.healthy);
        const someHealthy = Object.values(snap.sourceHealth).some((s) => s.healthy);
        const status = allHealthy ? 'healthy' : someHealthy ? 'degraded' : 'unhealthy';

        const body: Record<string, unknown> = {
          service: 'stellar-price-oracle-aggregator',
          status,
          uptime: snap.uptime,
          startupTimeMs: snap.startupTimeMs ?? 0,
          region: snap.region,
          timestamp: Math.floor(Date.now() / 1000),
          sources: Object.entries(snap.sourceHealth).map(([name, h]) => ({
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
          // #65 — include daily API call counts
          dailyApiCalls: getDailyCounts(),
          // #382 — on-chain price staleness heartbeat, per asset
          onChainHeartbeat: snap.onChainHeartbeat || {},
        };

        if (verbose) {
          body.sourceHealth = snap.sourceHealth;
          body.circuitBreakerMetrics = snap.circuitBreakerMetrics;
          body.circuitBreakerStates = snap.circuitBreakerStates;
          body.lastAggregated = snap.lastAggregated;
          body.replicatedPrices = snap.replicatedPrices;
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
    });

    this.server.listen(this.port, () => {
      logger.info(`Health server listening on port ${this.port}`);
      logger.info(`Metrics endpoint: http://localhost:${this.port}/metrics`);
    });
  }

  stop(): void {
    this.server?.close();
  }
}
