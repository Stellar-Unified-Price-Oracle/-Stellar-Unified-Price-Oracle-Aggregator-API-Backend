import { WebSocketServer as WsServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../middleware/logger';
import { validateWebSocketApiKey } from '../middleware/auth';
import { HybridCache } from '../services/cache';
import { validateWsAssets } from '../middleware/sanitization';
import { verifyWsSignature } from '../middleware/ws-signing';
import { config } from '../config';
import {
  wsConnectionsActive,
  wsConnectionsTotal,
  wsMessagesTotal,
  wsConnectionDuration,
  wsErrorsTotal,
  wsSubscribeEventsTotal,
} from '../middleware/metrics';

// Circular message buffer per asset for replay support
const MESSAGE_BUFFER_SIZE = parseInt(process.env.WS_BUFFER_SIZE || '200', 10);

interface BufferedMessage {
  sequenceId: number;
  asset: string;
  timestamp: number;
  data: any;
}

let globalSequence = 0;

function nextSeq(): number {
  return ++globalSequence;
}

export class PriceWebSocketServer {
  private wss: WsServer | null = null;
  private port: number;
  private clients: Set<WebSocket> = new Set();
  private subscriptions: Map<WebSocket, Set<string>> = new Map();
  private cache: HybridCache<any> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  // Per-asset circular message buffer for replay on reconnect
  private messageBuffers: Map<string, BufferedMessage[]> = new Map();

  constructor(port: number) {
    this.port = port;
  }

  start(): void {
    this.wss = new WsServer({ port: this.port, clientTracking: false });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const auth = validateWebSocketApiKey(req);
      if (!auth.valid) {
        ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: auth.error }));
        ws.close(1008, auth.error || 'Unauthorized');
        return;
      }

      const sigCheck = verifyWsSignature(req, config.ws.hmacSecret);
      if (!sigCheck.valid) {
        ws.send(JSON.stringify({ type: 'error', code: 'SIGNATURE_INVALID', message: sigCheck.error }));
        ws.close(1008, sigCheck.error || 'Invalid signature');
        return;
      }

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
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          wsErrorsTotal.inc();
        }
      });

      ws.on('close', () => {
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
        type: 'connected',
        clientCount: this.clients.size,
        sequenceId: globalSequence,
        replaySupported: true,
        bufferSize: MESSAGE_BUFFER_SIZE,
      }));
    });

    logger.info(`WebSocket server on port ${this.port}`);
  }

  private handleMessage(ws: WebSocket, msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      wsErrorsTotal.inc();
      return;
    }

    const m = msg as Record<string, unknown>;

    switch (m.type) {
      case 'subscribe':
        if (!validateWsAssets(m.assets)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid assets: must be an array of up to 50 valid asset symbols' }));
          return;
        }
        {
          const subs = this.subscriptions.get(ws);
          (m.assets as string[]).forEach((a) => subs?.add(a.toUpperCase()));
          ws.send(JSON.stringify({ type: 'subscribed', assets: m.assets, sequenceId: globalSequence }));
        }
        break;
      case 'unsubscribe':
        if (!validateWsAssets(m.assets)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid assets: must be an array of up to 50 valid asset symbols' }));
          return;
        }
        {
          const subs = this.subscriptions.get(ws);
          (m.assets as string[]).forEach((a) => subs?.delete(a.toUpperCase()));
          wsSubscribeEventsTotal.inc({ action: 'unsubscribe' });
          wsMessagesTotal.inc({ direction: 'inbound', type: 'unsubscribe' });
          ws.send(JSON.stringify({ type: 'unsubscribed', assets: m.assets }));
        }
        break;
      case 'replay': {
        // Client reconnected and wants missed messages since lastSequenceId
        const lastSeqRaw = m.lastSequenceId;
        const assets = m.assets;
        if (typeof lastSeqRaw !== 'number' || lastSeqRaw < 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'replay requires numeric lastSequenceId' }));
          return;
        }
        if (assets !== undefined && !validateWsAssets(assets)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid assets for replay' }));
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
            ws.send(JSON.stringify({ type: 'price_update', replayed: true, sequenceId: entry.sequenceId, data: entry.data }));
            replayed++;
          }
        }

        ws.send(JSON.stringify({ type: 'replay_complete', replayed, sequenceId: globalSequence }));
        break;
      }
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Math.floor(Date.now() / 1000), sequenceId: globalSequence }));
        break;
      default:
        wsErrorsTotal.inc();
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
  }

  private bufferMessage(asset: string, data: any): number {
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

  broadcast(data: any): void {
    const asset = data?.asset?.toUpperCase() || '_global';
    const seq = this.bufferMessage(asset, data);
    const message = JSON.stringify({ type: 'price_update', sequenceId: seq, ...data });
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        sent++;
      }
    });
    if (sent > 0) wsMessagesTotal.inc({ direction: 'outbound', type: 'price_update' }, sent);
  }

  broadcastToSubscribers(priceUpdate: any): void {
    const asset = priceUpdate?.asset?.toUpperCase();
    const seq = this.bufferMessage(asset || '_global', priceUpdate);
    const message = JSON.stringify({ type: 'price_update', sequenceId: seq, data: priceUpdate });

    this.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const subs = this.subscriptions.get(client);
      if (!subs || subs.size === 0 || (asset && subs.has(asset))) {
        client.send(message);
        sent++;
      }
    });

    if (sent > 0) wsMessagesTotal.inc({ direction: 'outbound', type: 'price_update' }, sent);
    this.invalidateCache(asset);
  }

  setCache(cache: HybridCache<any>): void {
    this.cache = cache;
  }

  private invalidateCache(_asset?: string): void {
    if (!this.cache) return;
    const patterns = ['prices:*', 'price:*', 'history:*', 'sources:*', 'health:*'];
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
    this.messageBuffers.clear();
  }
}
