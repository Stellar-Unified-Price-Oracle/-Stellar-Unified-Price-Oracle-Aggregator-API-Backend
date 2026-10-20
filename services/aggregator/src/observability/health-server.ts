import http from 'http';
import { logger } from './logger';
import { correlationHeaders } from '../infrastructure/correlation';
import { SourceCBStatus } from '../price-aggregation/source-circuit-breaker';
import { register } from './metrics';
import { getDailyCounts, getBudgetStatuses } from '../infrastructure/cost-model';
import { getUptimeHistory, getUptimeForPeriod, getLatestUptime } from '../persistence/uptime-history';
import type { SourceHealthStatus, AggregatedPrice } from '@stellar-oracle/types';
import type { RegionPriceRecord } from '../replication/price-crdt';

export interface CircuitBreakerMetrics {
  totalSources: number;
  suspiciousSources: number;
  suspiciousSourcesList: Array<{ key: string; deviations: number }>;
}

// #736 — a deployment cell bounds the blast radius of a single deployment or
// dependency failure to a fixed set of feeds and consumers.
export interface CellStatus {
  id: string;
  feeds: string[];
  dependencies: Record<string, boolean>;
  degraded: boolean;
  reason?: string;
}

// #737 — explicit per-feed ownership: primary/failover region and the epoch of
// the single authorized publisher.
export interface FeedOwnership {
  feed: string;
  primaryRegion: string;
  failoverRegion: string;
  ownerRegion: string;
  publisherEpoch: number;
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
  // Issue #590 — resolved listen ports (PORT base, PORT+1 WS, PORT+2 HTTP).
  ports?: { base: number; ws: number; http: number };
  // Issue #741 — controlled brownout state (current tier + shed features).
  brownout?: BrownoutSnapshot;
  // Issue #742 — planned maintenance window state (draining / fenced / validating).
  maintenance?: MaintenanceSnapshot;
}

export interface BrownoutSnapshot {
  active: boolean;
  tier: string;
  shedFeatures: string[];
  reason?: string;
  since?: number;
}

export interface MaintenanceSnapshot {
  active: boolean;
  phase: 'idle' | 'precheck' | 'draining' | 'fenced' | 'validating' | 'complete' | 'aborted';
  region?: string;
  startedAt?: number;
  deadlineAt?: number;
  publisherFenced: boolean;
  validationPassed?: boolean;
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
        const shuttingDown = snap.shutdownInProgress === true;
        // #742 — a cell being drained/fenced for maintenance must not receive traffic.
        const maintenanceActive = snap.maintenance?.active === true;
        const ready = hasPrices && !quarantined && !shuttingDown && !maintenanceActive
          && openCircuits.length < Object.keys(snap.sourceHealth).length;
        const code = ready ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: ready ? 'ready' : 'not_ready',
          hasPrices,
          quarantined,
          shutdownInProgress: shuttingDown,
          startupTimeMs: snap.startupTimeMs ?? 0,
          openCircuitBreakers: openCircuits.length,
          // #741 — brownout is a partial-service mode; readiness stays true but is surfaced.
          brownout: snap.brownout
            ? { active: snap.brownout.active, tier: snap.brownout.tier, shedFeatures: snap.brownout.shedFeatures }
            : { active: false, tier: 'none', shedFeatures: [] },
          // #742 — maintenance progress for orchestrators.
          maintenance: snap.maintenance
            ? { active: snap.maintenance.active, phase: snap.maintenance.phase, publisherFenced: snap.maintenance.publisherFenced }
            : { active: false, phase: 'idle', publisherFenced: false },
        }));
        return;
      }

      // #736 — cell boundaries, assigned feeds and dependency reachability.
      if (url.pathname === '/health/cells') {
        const snap = this.getSnapshot();
        const cells = (snap.cells ?? []).map((c) => ({
          id: c.id,
          feeds: c.feeds,
          dependencies: c.dependencies,
          degraded: c.degraded,
          reason: c.reason,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cells }));
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
          // #583 — per-source budget state (ok / warn / exhausted)
          budgetStatuses: getBudgetStatuses(),
          // #382 — on-chain price staleness heartbeat, per asset
          onChainHeartbeat: snap.onChainHeartbeat || {},
          // #590 — resolved listen ports, so drift is visible at runtime
          ...(snap.ports ? { ports: snap.ports } : {}),
          // #741 — controlled brownout state
          brownout: snap.brownout || { active: false, tier: 'none', shedFeatures: [] },
          // #742 — maintenance window state
          maintenance: snap.maintenance || { active: false, phase: 'idle', publisherFenced: false },
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
