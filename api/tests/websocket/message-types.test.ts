import { describe, it, expect } from 'vitest';
import {
  ClientMessageType,
  ServerMessageType,
  isClientMessageType,
  isServerMessageType,
} from '../../src/infrastructure/ws-messages';

describe('WebSocket message type enums (issue #301)', () => {
  it('defines the required client message types', () => {
    expect(ClientMessageType.Subscribe).toBe('subscribe');
    expect(ClientMessageType.Unsubscribe).toBe('unsubscribe');
    expect(ClientMessageType.Replay).toBe('replay');
    expect(ClientMessageType.Ping).toBe('ping');
  });

  it('defines the required server message types', () => {
    expect(ServerMessageType.Connected).toBe('connected');
    expect(ServerMessageType.Error).toBe('error');
    expect(ServerMessageType.Subscribed).toBe('subscribed');
    expect(ServerMessageType.Unsubscribed).toBe('unsubscribed');
    expect(ServerMessageType.PriceUpdate).toBe('price_update');
    expect(ServerMessageType.ReplayComplete).toBe('replay_complete');
    expect(ServerMessageType.Pong).toBe('pong');
  });

  it('recognizes known inbound message types', () => {
    expect(isClientMessageType('subscribe')).toBe(true);
    expect(isClientMessageType('unsubscribe')).toBe(true);
    expect(isClientMessageType('replay')).toBe(true);
    expect(isClientMessageType('ping')).toBe(true);
    expect(isClientMessageType('price_update')).toBe(false);
    expect(isClientMessageType('bogus')).toBe(false);
  });

  it('recognizes known outbound message types', () => {
    expect(isServerMessageType('price_update')).toBe(true);
    expect(isServerMessageType('error')).toBe(true);
    expect(isServerMessageType('connected')).toBe(true);
    expect(isServerMessageType('pong')).toBe(true);
    expect(isServerMessageType('subscribe')).toBe(false);
  });
});