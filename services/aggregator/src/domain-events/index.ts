import { NormalizedPrice, AggregatedPrice } from '../infrastructure/types';

export type DomainEvent =
  | PriceFetchedEvent
  | PriceAggregatedEvent
  | PricePublishedEvent
  | AnomalyDetectedEvent
  | SourceDegradedEvent;

export interface PriceFetchedEvent {
  type: 'price_fetched';
  payload: NormalizedPrice;
  timestamp: number;
}

export interface PriceAggregatedEvent {
  type: 'price_aggregated';
  payload: AggregatedPrice;
  timestamp: number;
}

export interface PricePublishedEvent {
  type: 'price_published';
  payload: AggregatedPrice[];
  timestamp: number;
}

export interface AnomalyDetectedEvent {
  type: 'anomaly_detected';
  payload: {
    asset: string;
    anomaly: AggregatedPrice['anomaly'];
  };
  timestamp: number;
}

export interface SourceDegradedEvent {
  type: 'source_degraded';
  payload: {
    source: string;
    reason: string;
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
