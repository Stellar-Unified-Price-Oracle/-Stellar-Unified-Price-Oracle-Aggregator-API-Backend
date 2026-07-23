export type DomainEvent =
  | PriceRequestedEvent
  | PriceHistoryRequestedEvent
  | ApiKeyCreatedEvent
  | ApiKeyRevokedEvent
  | WebhookReceivedEvent;

export interface PriceRequestedEvent {
  type: 'price-requested';
  payload: {
    asset?: string;
    ip?: string;
  };
  timestamp: number;
}

export interface PriceHistoryRequestedEvent {
  type: 'price-history-requested';
  payload: {
    asset: string;
    ip?: string;
  };
  timestamp: number;
}

export interface ApiKeyCreatedEvent {
  type: 'api-key-created';
  payload: {
    keyId: string;
    ownerId: string;
  };
  timestamp: number;
}

export interface ApiKeyRevokedEvent {
  type: 'api-key-revoked';
  payload: {
    keyId: string;
  };
  timestamp: number;
}

export interface WebhookReceivedEvent {
  type: 'webhook-received';
  payload: {
    source: string;
    eventType: string;
  };
  timestamp: number;
}

export class EventBus {
  private subscribers: Map<string, Set<(event: DomainEvent) => void>> = new Map();

  subscribe(eventType: DomainEvent['type'], handler: (event: DomainEvent) => void): void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(handler);
  }

  publish(event: DomainEvent): void {
    const handlers = this.subscribers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          // Log error but don't fail the entire process
          console.error('Event handler failed:', err);
        }
      }
    }
  }
}

export const eventBus = new EventBus();
