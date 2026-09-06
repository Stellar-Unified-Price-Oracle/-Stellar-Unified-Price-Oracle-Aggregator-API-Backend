import { WebSocketServer as WsServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../observability/logger';
import { validateWebSocketApiKey } from '../governance/auth';
import { HybridCache } from '../price-serving/cache';
import { ClientMessageType, ServerMessageType } from './ws-messages';
import { validateWsAssets } from '../governance/sanitization';
import { webhookService } from '../webhooks/webhook-service';
import { config } from './config';
import { WsUpgradeGuard } from './upgrade-guard';
import {
  wsConnectionsActive,
  wsConnectionsTotal,
  wsMessagesTotal,
  wsConnectionDuration,
  wsErrorsTotal,
  wsSubscribeEventsTotal,
} from '../observability/metrics';

// Circular message buffer per asset for replay support
const MESSAGE_BUFFER_SIZE = parseInt(process.env.WS_BUFFER_SIZE || '200', 10);

interface PriceUpdatePayload {
  asset?: string;
  price?: number;
  [key: string]: unknown;
}

interface BufferedMessage {
  sequenceId: number;
  asset: string;
  timestamp: number;
  data: PriceUpdatePayload;
}

let globalSequence = 0;

function nextSeq(): number {
  return ++globalSequence;
}

export class PriceWebSocketServer {
  private wss: WsServer | null = null;
  private port: number;
  private guard: WsUpgradeGuard;
  private clients: Set<WebSocket> = new Set();
  private subscriptions: Map<WebSocket, Set<string>> = new Map();
  private cache: HybridCache<unknown> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  // Per-asset circular message buffer for replay on reconnect
  private messageBuffers: Map<string, BufferedMessage[]> = new Map();

  constructor(port: number) {
    this.port = port;
    this.guard = new WsUpgradeGuard();
  }

  start(): void {
    this.wss = new WsServer({ port: this.port, clientTracking: false, verifyClient: this.guard.verifyClient });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const auth = validateWebSocketApiKey(req);
      if (!auth.valid) {
        ws.send(JSON.stringify({ type: ServerMessageType.Error, code: 'UNAUTHORIZED', message: auth.error }));
        ws.close(1008, auth.error || 'Unauthorized');
        return;
      }

      const ip = this.clientIp(req);
      this.guard.onConnect(ip);

      const connectedAt = Date.now();
      this.clients.add(ws);
      this.subscriptions.set(ws, new Set());

      wsConnectionsActive.inc();
      wsConnectionsTotal.inc();
      logger.info(`WS client connected (total: ${this.clients.size})`);

      ws.on('message', (raw: Buffer) => {
        wsMessagesTotal.inc({ direction: 'inbound', type: 'raw' });
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(ws, msg);
        } catch {
          ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Invalid JSON' }));
          wsErrorsTotal.inc();
        }
      });

      ws.on('close', () => {
        this.guard.onDisconnect(ip);
        this.clients.delete(ws);
        this.subscriptions.delete(ws);
        wsConnectionsActive.dec();
        wsConnectionDuration.observe((Date.now() - connectedAt) / 1000);
        logger.info(`WS client disconnected (total: ${this.clients.size})`);
      });

      ws.on('error', (err) => {
        wsErrorsTotal.inc();
        logger.error('WS error', err);
        this.clients.delete(ws);
        this.subscriptions.delete(ws);
      });

      ws.send(JSON.stringify({
        type: ServerMessageType.Connected,
        clientCount: this.clients.size,
        sequenceId: globalSequence,
        replaySupported: true,
        bufferSize: MESSAGE_BUFFER_SIZE,
      }));
    });

    logger.info(`WebSocket server on port ${this.port}`);

    this.sweepTimer = setInterval(() => this.guard.sweep(), config.ws.rateLimitWindowMs);
  }

  private handleMessage(ws: WebSocket, msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Invalid message' }));
      wsErrorsTotal.inc();
      return;
    }

    const m = msg as Record<string, unknown>;

    switch (m.type) {
      case ClientMessageType.Subscribe:
        if (!validateWsAssets(m.assets)) {
          ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Invalid assets: must be an array of up to 50 valid asset symbols' }));
          return;
        }
        {
          const subs = this.subscriptions.get(ws);
          (m.assets as string[]).forEach((a) => subs?.add(a.toUpperCase()));
          ws.send(JSON.stringify({ type: ServerMessageType.Subscribed, assets: m.assets, sequenceId: globalSequence }));
        }
        break;
      case ClientMessageType.Unsubscribe:
        if (!validateWsAssets(m.assets)) {
          ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Invalid assets: must be an array of up to 50 valid asset symbols' }));
          return;
        }
        {
          const subs = this.subscriptions.get(ws);
          (m.assets as string[]).forEach((a) => subs?.delete(a.toUpperCase()));
          wsSubscribeEventsTotal.inc({ action: 'unsubscribe' });
          wsMessagesTotal.inc({ direction: 'inbound', type: 'unsubscribe' });
          ws.send(JSON.stringify({ type: ServerMessageType.Unsubscribed, assets: m.assets }));
        }
        break;
      case ClientMessageType.Replay: {
        // Client reconnected and wants missed messages since lastSequenceId
        const lastSeqRaw = m.lastSequenceId;
        const assets = m.assets;
        if (typeof lastSeqRaw !== 'number' || lastSeqRaw < 0) {
          ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'replay requires numeric lastSequenceId' }));
          return;
        }
        if (assets !== undefined && !validateWsAssets(assets)) {
          ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Invalid assets for replay' }));
          return;
        }

        const requestedAssets = assets
          ? (assets as string[]).map((a) => a.toUpperCase())
          : null;

        let replayed = 0;
        const bufferSources = requestedAssets
          ? requestedAssets.map((a) => ({ asset: a, buf: this.messageBuffers.get(a) || [] }))
          : Array.from(this.messageBuffers.entries()).map(([asset, buf]) => ({ asset, buf }));

        const missed: BufferedMessage[] = [];
        for (const { buf } of bufferSources) {
          for (const entry of buf) {
            if (entry.sequenceId > lastSeqRaw) {
              missed.push(entry);
            }
          }
        }
        missed.sort((a, b) => a.sequenceId - b.sequenceId);

        for (const entry of missed) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: ServerMessageType.PriceUpdate, replayed: true, sequenceId: entry.sequenceId, data: entry.data }));
            replayed++;
          }
        }

        ws.send(JSON.stringify({ type: ServerMessageType.ReplayComplete, replayed, sequenceId: globalSequence }));
        break;
      }
      case ClientMessageType.Ping:
        ws.send(JSON.stringify({ type: ServerMessageType.Pong, timestamp: Math.floor(Date.now() / 1000), sequenceId: globalSequence }));
        break;
      default:
        wsErrorsTotal.inc();
        ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Unknown message type' }));
    }
  }

  private bufferMessage(asset: string, data: PriceUpdatePayload): number {
    const seq = nextSeq();
    const entry: BufferedMessage = { sequenceId: seq, asset, timestamp: Math.floor(Date.now() / 1000), data };

    if (!this.messageBuffers.has(asset)) {
      this.messageBuffers.set(asset, []);
    }
    const buf = this.messageBuffers.get(asset)!;
    buf.push(entry);
    if (buf.length > MESSAGE_BUFFER_SIZE) {
      buf.shift();
    }
    return seq;
  }

  broadcast(data: PriceUpdatePayload): void {
    const asset = data?.asset?.toUpperCase() || '_global';
    const seq = this.bufferMessage(asset, data);
    const message = JSON.stringify({ type: ServerMessageType.PriceUpdate, sequenceId: seq, ...data });
    let sent = 0;
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        sent++;
      }
    });
    if (sent > 0) wsMessagesTotal.inc({ direction: 'outbound', type: 'price_update' }, sent);
  }

  broadcastToSubscribers(priceUpdate: PriceUpdatePayload): void {
    const asset = priceUpdate?.asset?.toUpperCase();
    const seq = this.bufferMessage(asset || '_global', priceUpdate);
    const message = JSON.stringify({ type: ServerMessageType.PriceUpdate, sequenceId: seq, data: priceUpdate });
    let sent = 0;

    this.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const subs = this.subscriptions.get(client);
      if (!subs || subs.size === 0 || (asset && subs.has(asset))) {
        client.send(message);
        sent++;
      }
    });

    if (sent > 0) wsMessagesTotal.inc({ direction: 'outbound', type: ServerMessageType.PriceUpdate }, sent);
    this.invalidateCache(asset);

    // Fan out to registered webhooks for consumers without a WS connection.
    if (asset && typeof priceUpdate?.price === 'number') {
      void webhookService.handlePriceUpdate(asset, priceUpdate.price);
    }
  }

  setCache(cache: HybridCache<unknown>): void {
    this.cache = cache;
  }

  private invalidateCache(_asset?: string): void {
    if (!this.cache) return;
    const patterns = ['prices:*', 'price:*', 'history:*', 'sources:*', 'health:*'];
    patterns.forEach((pattern) => {
      this.cache!.invalidate(pattern).catch((err: Error) => {
        logger.warn(`Cache invalidation failed for pattern ${pattern}: ${err}`);
      });
    });
  }

  private clientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.wss?.close();
    this.clients.clear();
    this.subscriptions.clear();
    this.messageBuffers.clear();
  }
}
