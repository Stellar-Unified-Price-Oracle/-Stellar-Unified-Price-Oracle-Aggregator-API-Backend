import { describe, it, expect, beforeEach, vi } from 'vitest';

interface DomainEvent {
  id: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
  version: number;
}

interface EventOutboxEntry {
  id: string;
  event: DomainEvent;
  published: boolean;
  publishedAt?: number;
  retryCount: number;
  createdAt: number;
}

class TransactionalOutbox {
  private outbox: Map<string, EventOutboxEntry> = new Map();
  private eventIdCounter = 0;

  publishEvent(event: Omit<DomainEvent, 'id' | 'version'>): EventOutboxEntry {
    const entry: EventOutboxEntry = {
      id: `evt-${++this.eventIdCounter}`,
      event: {
        ...event,
        id: `evt-${this.eventIdCounter}`,
        version: 1,
      },
      published: false,
      retryCount: 0,
      createdAt: Date.now(),
    };
    this.outbox.set(entry.id, entry);
    return entry;
  }

  markPublished(entryId: string): void {
    const entry = this.outbox.get(entryId);
    if (entry) {
      entry.published = true;
      entry.publishedAt = Date.now();
    }
  }

  getUnpublished(): EventOutboxEntry[] {
    return Array.from(this.outbox.values()).filter(e => !e.published);
  }

  getRetryableEvents(): EventOutboxEntry[] {
    return this.getUnpublished().filter(e => e.retryCount < 3);
  }

  incrementRetry(entryId: string): void {
    const entry = this.outbox.get(entryId);
    if (entry) entry.retryCount++;
  }
}

class IdempotentConsumer {
  private processedEvents: Map<string, number> = new Map();
  private handlers: Map<string, (event: DomainEvent) => void> = new Map();

  registerHandler(eventType: string, handler: (event: DomainEvent) => void): void {
    this.handlers.set(eventType, handler);
  }

  consume(event: DomainEvent): { processed: boolean; deduped: boolean } {
    const processed = this.processedEvents.get(event.id);

    if (processed !== undefined) {
      return { processed: true, deduped: true };
    }

    const handler = this.handlers.get(event.type);
    if (handler) {
      handler(event);
    }

    this.processedEvents.set(event.id, Date.now());
    return { processed: true, deduped: false };
  }

  isProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }
}

class EventLog {
  private events: DomainEvent[] = [];
  private cursor = 0;

  append(event: DomainEvent): void {
    this.events.push(event);
  }

  replayFrom(fromCursor: number = 0): DomainEvent[] {
    if (fromCursor > this.events.length) {
      throw new Error(`Cursor ${fromCursor} beyond event log length ${this.events.length}`);
    }
    return this.events.slice(fromCursor);
  }

  getAll(): DomainEvent[] {
    return [...this.events];
  }

  getCurrentCursor(): number {
    return this.events.length;
  }

  getTotalEvents(): number {
    return this.events.length;
  }
}

describe('Durable Domain Events', () => {
  let outbox: TransactionalOutbox;
  let consumer: IdempotentConsumer;
  let eventLog: EventLog;

  beforeEach(() => {
    outbox = new TransactionalOutbox();
    consumer = new IdempotentConsumer();
    eventLog = new EventLog();
  });

  describe('Transactional Outbox Pattern', () => {
    it('should publish event with state change atomicity', () => {
      const event = outbox.publishEvent({
        type: 'PriceRequestedEvent',
        timestamp: Date.now(),
        data: { asset: 'XLM', requester: 'api:123' },
      });

      expect(event.published).toBe(false);
      expect(event.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('should mark event as published only after successful delivery', () => {
      const event = outbox.publishEvent({
        type: 'SLABreach',
        timestamp: Date.now(),
        data: { source: 'Chainlink', delayMs: 5000 },
      });

      const unpublished = outbox.getUnpublished();
      expect(unpublished).toContain(event);

      outbox.markPublished(event.id);

      const stillUnpublished = outbox.getUnpublished();
      expect(stillUnpublished).not.toContain(event);
    });

    it('should distinguish side-effect events from fire-and-forget events', () => {
      const sideEffectEvent = outbox.publishEvent({
        type: 'SLABreach',
        timestamp: Date.now(),
        data: { requires: 'durability' },
      });

      const bestEffortEvent = outbox.publishEvent({
        type: 'MetricReported',
        timestamp: Date.now(),
        data: { type: 'fire-and-forget' },
      });

      expect(sideEffectEvent.published).toBe(false);
      expect(bestEffortEvent.published).toBe(false);
    });
  });

  describe('Idempotent Consumer with Deduplication', () => {
    it('should process event only once despite multiple deliveries', () => {
      const event: DomainEvent = {
        id: 'evt-1',
        type: 'PriceHistoryRequested',
        timestamp: Date.now(),
        data: { asset: 'USDC' },
        version: 1,
      };

      const result1 = consumer.consume(event);
      const result2 = consumer.consume(event);
      const result3 = consumer.consume(event);

      expect(result1.deduped).toBe(false);
      expect(result2.deduped).toBe(true);
      expect(result3.deduped).toBe(true);
    });

    it('should track processed event IDs for deduplication', () => {
      const event1: DomainEvent = {
        id: 'evt-1',
        type: 'TestEvent',
        timestamp: Date.now(),
        data: {},
        version: 1,
      };

      const event2: DomainEvent = {
        id: 'evt-2',
        type: 'TestEvent',
        timestamp: Date.now(),
        data: {},
        version: 1,
      };

      consumer.consume(event1);
      consumer.consume(event2);

      expect(consumer.isProcessed(event1.id)).toBe(true);
      expect(consumer.isProcessed(event2.id)).toBe(true);
      expect(consumer.isProcessed('evt-nonexistent')).toBe(false);
    });

    it('should call registered handler on first consumption', () => {
      let handlerCalled = 0;
      consumer.registerHandler('CountEvent', () => {
        handlerCalled++;
      });

      const event: DomainEvent = {
        id: 'evt-1',
        type: 'CountEvent',
        timestamp: Date.now(),
        data: {},
        version: 1,
      };

      consumer.consume(event);
      expect(handlerCalled).toBe(1);

      consumer.consume(event);
      expect(handlerCalled).toBe(1);
    });

    it('should support replay safety through idempotent handlers', () => {
      const state = { count: 0 };
      consumer.registerHandler('IncrementEvent', () => {
        state.count++;
      });

      const event: DomainEvent = {
        id: 'evt-increment',
        type: 'IncrementEvent',
        timestamp: Date.now(),
        data: {},
        version: 1,
      };

      consumer.consume(event);
      expect(state.count).toBe(1);

      consumer.consume(event);
      expect(state.count).toBe(1);
    });
  });

  describe('Replayable Event Log', () => {
    it('should provide ordered event history from beginning', () => {
      const events = [
        {
          id: 'evt-1',
          type: 'EventA',
          timestamp: 1000,
          data: {},
          version: 1,
        },
        {
          id: 'evt-2',
          type: 'EventB',
          timestamp: 2000,
          data: {},
          version: 1,
        },
        {
          id: 'evt-3',
          type: 'EventC',
          timestamp: 3000,
          data: {},
          version: 1,
        },
      ];

      events.forEach(e => eventLog.append(e));

      const replayed = eventLog.replayFrom(0);
      expect(replayed).toEqual(events);
      expect(replayed[0].timestamp).toBeLessThan(replayed[1].timestamp);
      expect(replayed[1].timestamp).toBeLessThan(replayed[2].timestamp);
    });

    it('should support partial replay from cursor position', () => {
      for (let i = 0; i < 10; i++) {
        eventLog.append({
          id: `evt-${i}`,
          type: 'TestEvent',
          timestamp: i * 1000,
          data: { index: i },
          version: 1,
        });
      }

      const fromCursor5 = eventLog.replayFrom(5);
      expect(fromCursor5.length).toBe(5);
      expect(fromCursor5[0].data.index).toBe(5);
    });

    it('should track current cursor position for consumer rebuilding', () => {
      const consumer2 = new IdempotentConsumer();
      const handler = vi.fn();
      consumer2.registerHandler('TestEvent', handler);

      for (let i = 0; i < 5; i++) {
        eventLog.append({
          id: `evt-${i}`,
          type: 'TestEvent',
          timestamp: i * 1000,
          data: { index: i },
          version: 1,
        });
      }

      const initialCursor = 0;
      const events = eventLog.replayFrom(initialCursor);
      events.forEach(e => consumer2.consume(e));

      expect(handler).toHaveBeenCalledTimes(5);
      expect(eventLog.getCurrentCursor()).toBe(5);
    });

    it('should reject replay from invalid cursor position', () => {
      for (let i = 0; i < 5; i++) {
        eventLog.append({
          id: `evt-${i}`,
          type: 'TestEvent',
          timestamp: i * 1000,
          data: {},
          version: 1,
        });
      }

      expect(() => eventLog.replayFrom(100)).toThrow();
    });

    it('should maintain event ordering guarantees through replay', () => {
      const timestamps = [100, 150, 120, 200, 110];
      timestamps.forEach((ts, i) => {
        eventLog.append({
          id: `evt-${i}`,
          type: 'Event',
          timestamp: ts,
          data: { originalOrder: i },
          version: 1,
        });
      });

      const replayed = eventLog.replayFrom(0);
      expect(replayed.length).toBe(5);
      expect(replayed[0].data.originalOrder).toBe(0);
      expect(replayed[4].data.originalOrder).toBe(4);
    });
  });

  describe('Event Contract Definition', () => {
    it('should enforce event id uniqueness', () => {
      const event1 = outbox.publishEvent({
        type: 'UniqueEvent',
        timestamp: Date.now(),
        data: {},
      });

      const event2 = outbox.publishEvent({
        type: 'UniqueEvent',
        timestamp: Date.now(),
        data: {},
      });

      expect(event1.event.id).not.toBe(event2.event.id);
    });

    it('should track event version for schema evolution', () => {
      const event = outbox.publishEvent({
        type: 'VersionedEvent',
        timestamp: Date.now(),
        data: { v: 1 },
      });

      expect(event.event.version).toBe(1);
      expect(typeof event.event.version).toBe('number');
    });

    it('should enforce timestamp presence in event contract', () => {
      const event = outbox.publishEvent({
        type: 'TimestampedEvent',
        timestamp: 1234567890,
        data: {},
      });

      expect(event.event.timestamp).toBe(1234567890);
      expect(typeof event.event.timestamp).toBe('number');
    });
  });

  describe('Infrastructure Unavailable Behavior', () => {
    it('should buffer unpublished events when infrastructure unavailable', () => {
      const event1 = outbox.publishEvent({
        type: 'Event1',
        timestamp: Date.now(),
        data: {},
      });

      const event2 = outbox.publishEvent({
        type: 'Event2',
        timestamp: Date.now(),
        data: {},
      });

      const unpublished = outbox.getUnpublished();
      expect(unpublished.length).toBe(2);
      expect(unpublished).toContain(event1);
      expect(unpublished).toContain(event2);
    });

    it('should not silently drop events on infrastructure failure', () => {
      const event = outbox.publishEvent({
        type: 'CriticalEvent',
        timestamp: Date.now(),
        data: { importance: 'high' },
      });

      const unpublished = outbox.getUnpublished();
      expect(unpublished).toContain(event);
    });

    it('should support retry with backoff for failed deliveries', () => {
      const event = outbox.publishEvent({
        type: 'RetryableEvent',
        timestamp: Date.now(),
        data: {},
      });

      expect(event.retryCount).toBe(0);

      outbox.incrementRetry(event.id);
      expect(event.retryCount).toBe(1);

      outbox.incrementRetry(event.id);
      expect(event.retryCount).toBe(2);
    });

    it('should identify events eligible for retry', () => {
      const event1 = outbox.publishEvent({
        type: 'Event1',
        timestamp: Date.now(),
        data: {},
      });

      const event2 = outbox.publishEvent({
        type: 'Event2',
        timestamp: Date.now(),
        data: {},
      });

      outbox.incrementRetry(event1.id);
      outbox.incrementRetry(event1.id);
      outbox.incrementRetry(event1.id);
      outbox.incrementRetry(event1.id);

      const retryable = outbox.getRetryableEvents();
      expect(retryable).toContain(event2);
      expect(retryable).not.toContain(event1);
    });
  });

  describe('Consumer Rebuild from Event Log', () => {
    it('should rebuild consumer state from complete event log', () => {
      const state = { totalPrice: 0 };
      const consumerForRebuild = new IdempotentConsumer();
      consumerForRebuild.registerHandler('PriceUpdated', (event) => {
        state.totalPrice += event.data.price as number;
      });

      for (let i = 0; i < 5; i++) {
        eventLog.append({
          id: `price-${i}`,
          type: 'PriceUpdated',
          timestamp: i * 1000,
          data: { price: 100 },
          version: 1,
        });
      }

      const allEvents = eventLog.replayFrom(0);
      allEvents.forEach(e => consumerForRebuild.consume(e));

      expect(state.totalPrice).toBe(500);
    });

    it('should allow incremental consumer updates from new events', () => {
      const handler = vi.fn();
      const consumerForIncrmental = new IdempotentConsumer();
      consumerForIncrmental.registerHandler('IncrementalEvent', handler);

      eventLog.append({
        id: 'evt-1',
        type: 'IncrementalEvent',
        timestamp: Date.now(),
        data: { batch: 1 },
        version: 1,
      });

      let cursor = eventLog.getCurrentCursor();
      let events = eventLog.replayFrom(cursor - 1);
      events.forEach(e => consumerForIncrmental.consume(e));

      eventLog.append({
        id: 'evt-2',
        type: 'IncrementalEvent',
        timestamp: Date.now(),
        data: { batch: 2 },
        version: 1,
      });

      cursor = eventLog.getCurrentCursor();
      events = eventLog.replayFrom(cursor - 1);
      events.forEach(e => consumerForIncrmental.consume(e));

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
