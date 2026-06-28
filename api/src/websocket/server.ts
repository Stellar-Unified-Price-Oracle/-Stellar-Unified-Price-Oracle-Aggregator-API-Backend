import { WebSocketServer as WsServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { logger } from '../middleware/logger';
import { HybridCache } from '../services/cache';
import { WsUpgradeGuard } from './upgrade-guard';

export class PriceWebSocketServer {
  private wss: WsServer | null = null;
  private port: number;
  private clients: Set<WebSocket> = new Set();
  private subscriptions: Map<WebSocket, Set<string>> = new Map();
  private cache: HybridCache<any> | null = null;
  private guard = new WsUpgradeGuard();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(port: number) {
    this.port = port;
  }

  start(): void {
    // Validate every upgrade (origin, rate limit, CSRF) before accepting it.
    this.wss = new WsServer({ port: this.port, verifyClient: this.guard.verifyClient });

    // Periodically discard stale per-IP rate-limit buckets.
    this.sweepTimer = setInterval(() => this.guard.sweep(), 60000);
    this.sweepTimer.unref?.();

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip = req.socket.remoteAddress || 'unknown';
      this.clients.add(ws);
      this.subscriptions.set(ws, new Set());
      logger.info(`WS client connected from ${ip} (total: ${this.clients.size})`);

      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(ws, msg);
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.subscriptions.delete(ws);
        logger.info(`WS client disconnected (total: ${this.clients.size})`);
      });

      ws.on('error', (err) => {
        logger.error('WS error', err);
        this.clients.delete(ws);
        this.subscriptions.delete(ws);
      });

      ws.send(JSON.stringify({ type: 'connected', clientCount: this.clients.size }));
    });

    logger.info(`WebSocket server on port ${this.port}`);
  }

  private handleMessage(ws: WebSocket, msg: any): void {
    switch (msg.type) {
      case 'subscribe':
        if (msg.assets && Array.isArray(msg.assets)) {
          const subs = this.subscriptions.get(ws);
          msg.assets.forEach((a: string) => subs?.add(a.toUpperCase()));
          ws.send(JSON.stringify({ type: 'subscribed', assets: msg.assets }));
        }
        break;
      case 'unsubscribe':
        if (msg.assets && Array.isArray(msg.assets)) {
          const subs = this.subscriptions.get(ws);
          msg.assets.forEach((a: string) => subs?.delete(a.toUpperCase()));
          ws.send(JSON.stringify({ type: 'unsubscribed', assets: msg.assets }));
        }
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Math.floor(Date.now() / 1000) }));
        break;
    }
  }

  broadcast(data: any): void {
    const message = JSON.stringify({ type: 'price_update', ...data });
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastToSubscribers(priceUpdate: any): void {
    const asset = priceUpdate?.asset?.toUpperCase();
    const message = JSON.stringify({ type: 'price_update', data: priceUpdate });

    this.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const subs = this.subscriptions.get(client);
      if (!subs || subs.size === 0 || (asset && subs.has(asset))) {
        client.send(message);
      }
    });

    this.invalidateCache(asset);
  }

  setCache(cache: HybridCache<any>): void {
    this.cache = cache;
  }

  private invalidateCache(_asset?: string): void {
    if (!this.cache) return;
    const patterns = [
      'prices:*',
      'price:*',
      'history:*',
      'sources:*',
      'health:*',
    ];
    patterns.forEach((pattern) => {
      this.cache!.invalidate(pattern).catch((err) => {
        logger.warn(`Cache invalidation failed for pattern ${pattern}: ${err}`);
      });
    });
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.wss?.close();
    this.clients.clear();
    this.subscriptions.clear();
  }
}
