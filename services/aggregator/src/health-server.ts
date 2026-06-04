import http from 'http';
import { logger } from './utils/logger';

interface HealthSnapshot {
  sourceHealth: Record<string, any>;
  lastAggregated: any[];
  uptime: number;
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
    this.server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        const snap = this.getSnapshot();
        const allHealthy = Object.values(snap.sourceHealth).every((s: any) => s.healthy);
        const status = allHealthy ? 'healthy' : snap.lastAggregated.length > 0 ? 'degraded' : 'unhealthy';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'stellar-price-oracle-aggregator',
          status,
          ...snap,
          timestamp: Math.floor(Date.now() / 1000),
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(this.port, () => {
      logger.info(`Health server listening on port ${this.port}`);
    });
  }

  stop(): void {
    this.server?.close();
  }
}
