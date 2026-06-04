import { WebSocketServer as WsServer, WebSocket } from 'ws';
import { logger } from './utils/logger';

export class WebSocketServer {
  private wss: WsServer | null = null;
  private port: number;

  constructor(port: number) {
    this.port = port;
  }

  start(): void {
    this.wss = new WsServer({ port: this.port + 1 });
    this.wss.on('connection', (ws: WebSocket) => {
      logger.info(`WebSocket client connected (total: ${this.wss?.clients.size})`);

      ws.on('close', () => {
        logger.info(`WebSocket client disconnected (total: ${this.wss?.clients.size})`);
      });

      ws.on('error', (err) => {
        logger.error('WebSocket error', err);
      });
    });

    logger.info(`WebSocket server listening on port ${this.port + 1}`);
  }

  broadcast(data: unknown): void {
    if (!this.wss) return;
    const message = JSON.stringify(data);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  stop(): void {
    this.wss?.close();
  }
}
