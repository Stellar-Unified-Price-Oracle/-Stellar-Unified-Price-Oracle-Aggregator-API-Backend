/**
 * #118 — Event Sourcing + CQRS
 *
 * Implements an append-only in-memory event store with:
 *   - Exactly-once processing guard (deduplication via event ID)
 *   - Projection rebuild from scratch
 *   - Separate read-model (query) and write-model (command) interfaces
 *   - Snapshot support to bound replay time
 *
 * In production, swap the in-memory store for a PostgreSQL append-only table
 * or a dedicated event-store service by implementing the EventStorage interface.
 *
 * ┌─────────────────────────────────────────┐
 * │  WRITE SIDE (Commands)                  │
 * │  CommandHandler → EventStore.append()   │
 * └───────────────┬─────────────────────────┘
 *                 │ events
 * ┌───────────────▼─────────────────────────┐
 * │  READ SIDE (Projections / Query models) │
 *  ProjectionEngine.rebuild()               │
 *  ReadModelStore.*                         │
 * └─────────────────────────────────────────┘
 */

import { randomUUID } from 'crypto';
import { logger as defaultLogger } from '../observability/logger';

// ---------------------------------------------------------------------------
// Domain event types
// ---------------------------------------------------------------------------

export type EventType =
  | 'PriceUpdated'
  | 'SourceAdded'
  | 'SourceRemoved'
  | 'AggregationCompleted'
  | 'AlertTriggered'
  | 'CircuitBreakerOpened'
  | 'CircuitBreakerClosed';

export interface DomainEvent<P = unknown> {
  /** Globally unique event id — used for exactly-once dedup. */
  id: string;
  /** Aggregate stream this event belongs to (e.g. "price:XLM", "source:coinbase"). */
  streamId: string;
  type: EventType;
  payload: P;
  /** Causal correlation id (e.g. inbound request id). */
  correlationId?: string;
  /** Wall-clock UTC timestamp (ms since epoch). */
  occurredAt: number;
  /** Version within the aggregate stream (1-based). */
  version: number;
}

// Typed payloads
export interface PriceUpdatedPayload {
  asset: string;
  price: number;
  source: string;
  confidence: number;
}

export interface SourceAddedPayload {
  sourceId: string;
  name: string;
  url: string;
  weight: number;
}

export interface AggregationCompletedPayload {
  asset: string;
  aggregatedPrice: number;
  sourcesUsed: number;
  strategy: string;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface Snapshot<S = unknown> {
  streamId: string;
  state: S;
  atVersion: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Event storage interface (swap for a DB-backed implementation in production)
// ---------------------------------------------------------------------------

export interface EventStorage {
  append(event: DomainEvent): Promise<void>;
  readStream(streamId: string, fromVersion?: number): Promise<DomainEvent[]>;
  readAll(fromOffset?: number): Promise<DomainEvent[]>;
  totalCount(): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------

class InMemoryEventStorage implements EventStorage {
  private events: DomainEvent[] = [];
  private seenIds = new Set<string>();
  /** Version per stream, 1-based */
  private streamVersions: Map<string, number> = new Map();

  async append(event: DomainEvent): Promise<void> {
    if (this.seenIds.has(event.id)) {
      // Exactly-once guard — idempotent append
      defaultLogger.debug('Duplicate event ignored (exactly-once guard)', { eventId: event.id });
      return;
    }
    this.seenIds.add(event.id);
    this.events.push(event);
    this.streamVersions.set(event.streamId, event.version);
  }

  async readStream(streamId: string, fromVersion = 1): Promise<DomainEvent[]> {
    return this.events.filter(
      (e) => e.streamId === streamId && e.version >= fromVersion
    );
  }

  async readAll(fromOffset = 0): Promise<DomainEvent[]> {
    return this.events.slice(fromOffset);
  }

  async totalCount(): Promise<number> {
    return this.events.length;
  }

  nextVersion(streamId: string): number {
    return (this.streamVersions.get(streamId) ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Event store (public write API)
// ---------------------------------------------------------------------------

export class EventStore {
  private storage: InMemoryEventStorage;
  private snapshots: Map<string, Snapshot> = new Map();

  constructor(storage?: EventStorage) {
    // For now always use in-memory; swap in production
    this.storage = storage as InMemoryEventStorage ?? new InMemoryEventStorage();
  }

  /**
   * Append an event to a stream.
   * @param streamId   - Aggregate identifier (e.g. "price:XLM")
   * @param type       - Event type
   * @param payload    - Event payload
   * @param opts       - Optional correlation id
   * @returns The persisted DomainEvent
   */
  async append<P>(
    streamId: string,
    type: EventType,
    payload: P,
    opts: { correlationId?: string } = {}
  ): Promise<DomainEvent<P>> {
    const version = this.storage.nextVersion(streamId);
    const event: DomainEvent<P> = {
      id: randomUUID(),
      streamId,
      type,
      payload,
      correlationId: opts.correlationId,
      occurredAt: Date.now(),
      version,
    };
    await this.storage.append(event as DomainEvent);
    defaultLogger.debug('Event appended', { eventId: event.id, streamId, type, version });
    return event;
  }

  /** Read all events for a stream, optionally starting from a version. */
  async readStream(streamId: string, fromVersion = 1): Promise<DomainEvent[]> {
    return this.storage.readStream(streamId, fromVersion);
  }

  /** Read every event across all streams (for projection rebuild). */
  async readAll(fromOffset = 0): Promise<DomainEvent[]> {
    return this.storage.readAll(fromOffset);
  }

  async totalCount(): Promise<number> {
    return this.storage.totalCount();
  }

  /** Save a snapshot so projections can start from a known state. */
  saveSnapshot<S>(streamId: string, state: S, atVersion: number): void {
    this.snapshots.set(streamId, { streamId, state, atVersion, createdAt: Date.now() });
  }

  getSnapshot<S>(streamId: string): Snapshot<S> | undefined {
    return this.snapshots.get(streamId) as Snapshot<S> | undefined;
  }
}

// ---------------------------------------------------------------------------
// Projection engine (READ SIDE)
// ---------------------------------------------------------------------------

export type ProjectionHandler<S> = (state: S, event: DomainEvent) => S;

export interface Projection<S> {
  name: string;
  initialState: S;
  handlers: Partial<Record<EventType, ProjectionHandler<S>>>;
}

export class ProjectionEngine {
  constructor(private readonly eventStore: EventStore) {}

  /**
   * Rebuild a projection from scratch (or from the last snapshot).
   * This is the "exactly-once" safe path — events are replayed in order.
   */
  async rebuild<S>(projection: Projection<S>): Promise<S> {
    const snapshot = this.eventStore.getSnapshot<S>(projection.name);
    let state = snapshot ? snapshot.state : projection.initialState;
    const fromOffset = snapshot ? snapshot.atVersion : 0;
    const events = await this.eventStore.readAll(fromOffset);

    for (const event of events) {
      const handler = projection.handlers[event.type];
      if (handler) {
        state = handler(state, event);
      }
    }

    // Optionally save a fresh snapshot after rebuild
    const total = await this.eventStore.totalCount();
    this.eventStore.saveSnapshot(projection.name, state, total);

    return state;
  }
}

// ---------------------------------------------------------------------------
// Built-in projections (READ MODELS)
// ---------------------------------------------------------------------------

export interface LatestPriceReadModel {
  [asset: string]: {
    price: number;
    source: string;
    confidence: number;
    updatedAt: number;
    version: number;
  };
}

export const latestPriceProjection: Projection<LatestPriceReadModel> = {
  name: 'latest-prices',
  initialState: {},
  handlers: {
    PriceUpdated: (state, event) => {
      const p = event.payload as PriceUpdatedPayload;
      return {
        ...state,
        [p.asset]: {
          price: p.price,
          source: p.source,
          confidence: p.confidence,
          updatedAt: event.occurredAt,
          version: event.version,
        },
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Command handlers (WRITE SIDE)
// ---------------------------------------------------------------------------

export interface RecordPriceUpdateCommand {
  asset: string;
  price: number;
  source: string;
  confidence?: number;
  correlationId?: string;
}

export class PriceCommandHandler {
  constructor(private readonly eventStore: EventStore) {}

  async recordPriceUpdate(cmd: RecordPriceUpdateCommand): Promise<DomainEvent> {
    if (cmd.price <= 0) throw new Error('Price must be positive');
    return this.eventStore.append<PriceUpdatedPayload>(
      `price:${cmd.asset}`,
      'PriceUpdated',
      { asset: cmd.asset, price: cmd.price, source: cmd.source, confidence: cmd.confidence ?? 1 },
      { correlationId: cmd.correlationId }
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton instances (swap for DI container in larger setups)
// ---------------------------------------------------------------------------

export const globalEventStore = new EventStore();
export const globalProjectionEngine = new ProjectionEngine(globalEventStore);
export const priceCommandHandler = new PriceCommandHandler(globalEventStore);
