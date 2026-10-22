import { WebSocketServer as WsServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { logger } from '../observability/logger';
import { validateWebSocketApiKey } from '../governance/auth';
import { HybridCache } from '../price-serving/cache';
import { ClientMessageType, ServerMessageType } from './ws-messages';
import { validateWsAssets } from '../governance/sanitization';
import { webhookService } from '../webhooks/webhook-service';
import { clientIp as trustedClientIp } from '../platform/trusted-proxy';
import { config } from './config';
import { WsUpgradeGuard } from './upgrade-guard';
import {
  wsConnectionsActive,
  wsConnectionsTotal,
  wsMessagesTotal,
  wsConnectionDuration,
  wsErrorsTotal,
  wsSubscribeEventsTotal,
  wsReplayTotal,
  wsBufferedAssets,
  wsBufferBytes,
} from '../observability/metrics';
import { ReplayBuffer, ReplayRateLimiter, collectReplayWindow, BufferedMessage } from './ws-replay';
import { currentSequence, nextSequence } from './ws-sequence';

// Circular message buffer per asset for replay support
const MESSAGE_BUFFER_SIZE = config.ws.bufferSize;
const REPLAY_BOUNDS = { maxMessages: config.ws.replayMaxMessages, maxBytes: config.ws.replayMaxBytes };

interface PriceUpdatePayload {
  asset?: string;
  price?: number;
  [key: string]: unknown;
}

function nextSeq(): number {
  return nextSequence();
}

const getSequence = currentSequence;

export class PriceWebSocketServer {
  private wss: WsServer | null = null;
  private port: number;
  private guard: WsUpgradeGuard;
  private clients: Set<WebSocket> = new Set();
  private subscriptions: Map<WebSocket, Set<string>> = new Map();
  private clientIds: Map<WebSocket, string> = new Map();
  private cache: HybridCache<unknown> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  // Bounded per-asset replay buffer (issue #606)
  private replayBuffer = new ReplayBuffer(
    config.ws.bufferMaxAssets,
    MESSAGE_BUFFER_SIZE,
    config.ws.bufferMaxBytes,
  );
  private replayLimiter = new ReplayRateLimiter(config.ws.replayRateLimit, config.ws.replayRateWindowMs);
  private connectionKeys: Map<WebSocket, string> = new Map();
  private connectionSeq = 0;

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

      const ip = this.guard.resolveClientIp(req);
      this.guard.onConnect(ip);

      const connectedAt = Date.now();
      const clientId = randomUUID().slice(0, 8);
      this.clients.add(ws);
      this.clientIds.set(ws, clientId);
      this.subscriptions.set(ws, new Set());
      this.connectionKeys.set(ws, `${ip}#${++this.connectionSeq}`);

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
        this.clientIds.delete(ws);
        this.connectionKeys.delete(ws);
        wsConnectionsActive.dec();
        wsConnectionDuration.observe((Date.now() - connectedAt) / 1000);
        logger.info(`WS client disconnected (total: ${this.clients.size})`);
      });

      ws.on('error', (err) => {
        wsErrorsTotal.inc();
        logger.error('WS error', err);
        this.clients.delete(ws);
        this.subscriptions.delete(ws);
        this.clientIds.delete(ws);
        this.connectionKeys.delete(ws);
      });

      ws.send(JSON.stringify({
        type: ServerMessageType.Connected,
        clientCount: this.clients.size,
        sequenceId: getSequence(),
        sequenceModel: 'global',
        replaySupported: true,
        bufferSize: MESSAGE_BUFFER_SIZE,
        replayMaxMessages: REPLAY_BOUNDS.maxMessages,
        replayMaxBytes: REPLAY_BOUNDS.maxBytes,
      }));
    });

    logger.info(`WebSocket server on port ${this.port}`);

    this.sweepTimer = setInterval(() => {
      this.guard.sweep();
      this.replayLimiter.prune();
    }, config.ws.rateLimitWindowMs);
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
          wsSubscribeEventsTotal.inc({ action: 'subscribe' });
          this.publishSubscriptionGauge(ws);
          ws.send(JSON.stringify({ type: ServerMessageType.Subscribed, assets: m.assets, sequenceId: getSequence() }));
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
          this.publishSubscriptionGauge(ws);
          wsMessagesTotal.inc({ direction: 'inbound', type: 'unsubscribe' });
          ws.send(JSON.stringify({ type: ServerMessageType.Unsubscribed, assets: m.assets }));
        }
        break;
      case ClientMessageType.Replay: {
        // Client reconnected and wants missed messages since lastSequenceId
        const subscribed = this.subscriptions.get(ws) ?? new Set<string>();
        const lastSeqRaw = m.lastSequenceId;
        const assets = m.assets;
        if (typeof lastSeqRaw !== 'number' || lastSeqRaw < 0 || !Number.isInteger(lastSeqRaw)) {
          ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'replay requires numeric lastSequenceId' }));
          return;
        }
        if (assets !== undefined && !validateWsAssets(assets)) {
          ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Invalid assets for replay' }));
          return;
        }

        const key = this.connectionKeys.get(ws) ?? 'unknown';
        if (!this.replayLimiter.allow(key)) {
          wsReplayTotal.inc({ result: 'rate_limited' });
          ws.send(JSON.stringify({
            type: ServerMessageType.Error,
            code: 'REPLAY_RATE_LIMITED',
            message: `replay is limited to ${config.ws.replayRateLimit} requests per ${config.ws.replayRateWindowMs}ms; resubscribe to resume from ${getSequence()}`,
          }));
          return;
        }

        const requestedAssets = assets
          ? (assets as string[]).map((a) => a.toUpperCase())
          : null;
        // Replay never reaches beyond this connection's subscriptions: assets the
        // client did not subscribe to are dropped from the request scope, so an
        // unsubscribed connection replays nothing.
        const scopeAssets = requestedAssets
          ? requestedAssets.filter((a) => subscribed.has(a))
          : Array.from(subscribed);

        const window = collectReplayWindow(
          this.replayBuffer.sources(scopeAssets),
          lastSeqRaw,
          REPLAY_BOUNDS,
        );

        let replayed = 0;
        let lastDelivered = lastSeqRaw;
        for (const entry of window.messages) {
          if (ws.readyState !== WebSocket.OPEN) break;
          ws.send(JSON.stringify({ type: ServerMessageType.PriceUpdate, replayed: true, sequenceId: entry.sequenceId, data: entry.data }));
          replayed++;
          lastDelivered = entry.sequenceId;
        }

        wsReplayTotal.inc({ result: window.truncated ? 'truncated' : 'complete' });
        const oldestReplayableSequence = this.replayBuffer.oldestSequence(scopeAssets);
        ws.send(JSON.stringify({
          type: ServerMessageType.ReplayComplete,
          replayed,
          sequenceId: getSequence(),
          lastSequenceId: lastDelivered,
          truncated: window.truncated,
          remaining: window.remaining,
          gapDetected: oldestReplayableSequence !== null && lastSeqRaw < oldestReplayableSequence - 1,
          oldestReplayableSequence,
        }));
        break;
      }
      case ClientMessageType.Ping:
        ws.send(JSON.stringify({ type: ServerMessageType.Pong, timestamp: Math.floor(Date.now() / 1000), sequenceId: getSequence() }));
        break;
      default:
        wsErrorsTotal.inc();
        ws.send(JSON.stringify({ type: ServerMessageType.Error, message: 'Unknown message type' }));
    }
  }

  private bufferMessage(asset: string, data: PriceUpdatePayload): number {
    const seq = nextSeq();
    const entry: BufferedMessage = { sequenceId: seq, asset, timestamp: Math.floor(Date.now() / 1000), data };
    this.replayBuffer.push(asset, entry);
    const stats = this.replayBuffer.stats();
    wsBufferedAssets.set(stats.assets);
    wsBufferBytes.set(stats.bytes);
    return seq;
  }

  private subscriptionMatches(client: WebSocket, asset: string | undefined): boolean {
    const subs = this.subscriptions.get(client);
    return Boolean(subs && subs.size > 0 && asset && subs.has(asset));
  }

  private countDelivered(client: WebSocket): void {
    const clientId = this.clientIds.get(client);
    if (clientId) wsClientMessagesTotal.inc({ client: clientId, result: 'delivered' });
  }

  private countDropped(client: WebSocket): void {
    const clientId = this.clientIds.get(client);
    if (clientId) wsClientMessagesTotal.inc({ client: clientId, result: 'dropped' });
  }

  private publishSubscriptionGauge(client: WebSocket): void {
    const clientId = this.clientIds.get(client);
    const subs = this.subscriptions.get(client);
    if (clientId && subs) wsClientSubscriptions.set({ client: clientId }, subs.size);
  }

  private forget(client: WebSocket): void {
    const clientId = this.clientIds.get(client);
    this.clients.delete(client);
    this.subscriptions.delete(client);
    if (clientId) {
      this.clientIds.delete(client);
      wsClientSubscriptions.remove(clientId);
    }
  }

  broadcast(data: PriceUpdatePayload): void {
    const rawAsset = data?.asset?.toUpperCase();
    const asset = rawAsset || '_global';
    const seq = this.bufferMessage(asset, data);
    const message = JSON.stringify({ type: ServerMessageType.PriceUpdate, sequenceId: seq, ...data });
    let sent = 0;
    this.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (!this.subscriptionMatches(client, rawAsset)) {
        this.countDropped(client);
        return;
      }
      client.send(message);
      sent++;
      this.countDelivered(client);
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
      if (!this.subscriptionMatches(client, asset)) {
        this.countDropped(client);
        return;
      }
      client.send(message);
      sent++;
      this.countDelivered(client);
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
    return trustedClientIp(req);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.wss?.close();
    this.clients.clear();
    this.subscriptions.clear();
    this.connectionKeys.clear();
    this.replayLimiter.reset();
    this.replayBuffer.clear();
    wsBufferedAssets.set(0);
    wsBufferBytes.set(0);
  }
}
