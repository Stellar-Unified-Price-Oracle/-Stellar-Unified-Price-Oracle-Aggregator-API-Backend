import { WebSocketServer as WsServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { logger } from './utils/logger';
import { WsConnectionGuard } from './utils/ws-guard';
import {
  wsConnectionsActive,
  wsConnectionsTotal,
  wsMessagesTotal,
  wsConnectionDuration,
  wsErrorsTotal,
} from './metrics';

const SERVICE = 'aggregator';

export class WebSocketServer {
  private wss: WsServer | null = null;
  private port: number;
  private guard = new WsConnectionGuard();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(port: number) {
    this.port = port;
  }

  start(): void {
    this.wss = new WsServer({ port: this.port + 1, verifyClient: this.guard.verifyClient });
    this.sweepTimer = setInterval(() => this.guard.sweep(), 60000);
    this.sweepTimer.unref?.();

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip = req.socket.remoteAddress || 'unknown';
      const connectedAt = Date.now();

      wsConnectionsActive.inc({ service: SERVICE });
      wsConnectionsTotal.inc({ service: SERVICE });
      logger.info(`WebSocket client connected from ${ip} (total: ${this.wss?.clients.size})`);

      ws.on('message', () => {
        wsMessagesTotal.inc({ service: SERVICE, direction: 'inbound' });
      });

      ws.on('close', () => {
        wsConnectionsActive.dec({ service: SERVICE });
        wsConnectionDuration.observe({ service: SERVICE }, (Date.now() - connectedAt) / 1000);
        logger.info(`WebSocket client disconnected (total: ${this.wss?.clients.size})`);
      });

      ws.on('error', (err) => {
        wsErrorsTotal.inc({ service: SERVICE });
        logger.error('WebSocket error', err);
      });
    });

    logger.info(`WebSocket server listening on port ${this.port + 1}`);
  }

  broadcast(data: unknown): void {
    if (!this.wss) return;
    const message = JSON.stringify(data);
    let sent = 0;
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        sent++;
      }
    });
    if (sent > 0) wsMessagesTotal.inc({ service: SERVICE, direction: 'outbound' }, sent);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.wss?.close();
  }
}
