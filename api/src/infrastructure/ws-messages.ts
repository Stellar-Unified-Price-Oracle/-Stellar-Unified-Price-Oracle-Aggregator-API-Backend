/**
 * WebSocket message type definitions for the price streaming server.
 *
 * Client→server and server→client message types are declared as string enums so
 * callers get compile-time checking and typos are impossible. Each inline-flat
 * message that the server emits is additionally modeled with a discriminated
 * union on `type` so consumers and tests can narrow on the message kind.
 *
 * This file covers the API socket (3001). The aggregator's push socket
 * (`PORT + 1`, 4001 by default) runs a separate versioned envelope with its own
 * subscription and backpressure rules — see docs/AGGREGATOR_WEBSOCKET.md and
 * services/aggregator/src/infrastructure/ws-protocol.ts.
 */

/** Messages the client sends to the server (inbound). */
export enum ClientMessageType {
  Subscribe = 'subscribe',
  Unsubscribe = 'unsubscribe',
  Replay = 'replay',
  Ping = 'ping',
}

/** Messages the server sends to the client (outbound). */
export enum ServerMessageType {
  Connected = 'connected',
  Error = 'error',
  Subscribed = 'subscribed',
  Unsubscribed = 'unsubscribed',
  PriceUpdate = 'price_update',
  ReplayComplete = 'replay_complete',
  Pong = 'pong',
}

const CLIENT_MESSAGES: readonly string[] = Object.values(ClientMessageType);
const SERVER_MESSAGES: readonly string[] = Object.values(ServerMessageType);

/** Whether an arbitrary `type` string is a known client (inbound) message type. */
export function isClientMessageType(type: string): type is ClientMessageType {
  return (CLIENT_MESSAGES as string[]).includes(type);
}

/** Whether an arbitrary `type` string is a known server (outbound) message type. */
export function isServerMessageType(type: string): type is ServerMessageType {
  return (SERVER_MESSAGES as string[]).includes(type);
}

// ── Server → client messages (discriminated union on `type`) ────────────────

export interface ConnectedMessage {
  type: ServerMessageType.Connected;
  clientCount: number;
  sequenceId: number;
  sequenceModel: 'global';
  replaySupported: boolean;
  bufferSize: number;
  replayMaxMessages: number;
  replayMaxBytes: number;
}

export interface ErrorMessage {
  type: ServerMessageType.Error;
  code?: string;
  message: string;
  /**
   * Assets that were rejected because the credential's feed scopes do not
   * cover them. Present only on scope-denied errors (code `scope_denied`).
   */
  deniedAssets?: string[];
}

export interface SubscribedMessage {
  type: ServerMessageType.Subscribed;
  assets: unknown;
  sequenceId: number;
}

export interface UnsubscribedMessage {
  type: ServerMessageType.Unsubscribed;
  assets: unknown;
}

export interface PriceUpdateMessage {
  type: ServerMessageType.PriceUpdate;
  sequenceId: number;
  replayed?: boolean;
  data?: unknown;
  asset?: string;
}

/**
 * ReplayCompleteMessage.truncated tells a client whether it is caught up
 * (false: every buffered message above lastSequenceId was delivered) or the
 * bounded window was exhausted (true: `remaining` messages were withheld, so
 * the client must resync from `lastSequenceId` or resubscribe).
 */
export interface ReplayCompleteMessage {
  type: ServerMessageType.ReplayComplete;
  replayed: number;
  sequenceId: number;
  lastSequenceId: number;
  truncated: boolean;
  remaining: number;
}

export interface PongMessage {
  type: ServerMessageType.Pong;
  timestamp: number;
  sequenceId: number;
}

/** Discriminated union of every message the server can emit. */
export type ServerMessage =
  | ConnectedMessage
  | ErrorMessage
  | SubscribedMessage
  | UnsubscribedMessage
  | PriceUpdateMessage
  | ReplayCompleteMessage
  | PongMessage;

// ── Client → server message shapes ──────────────────────────────────────────

export interface SubscribeMessage {
  type: ClientMessageType.Subscribe;
  assets: string[];
}

export interface UnsubscribeMessage {
  type: ClientMessageType.Unsubscribe;
  assets: string[];
}

export interface ReplayMessage {
  type: ClientMessageType.Replay;
  lastSequenceId: number;
  assets?: string[];
}

export interface PingMessage {
  type: ClientMessageType.Ping;
}

/** Discriminated union of messages the client can send. */
export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | ReplayMessage
  | PingMessage;