import { NormalizedPrice, AggregatedPrice } from '../infrastructure/types';
import {
  decodeContractEvent,
  ContractEventDecodeError,
  ContractEventVersionError,
  DecodedContractEvent,
  SUPPORTED_CONTRACT_EVENT_VERSIONS,
} from '@refract/types';

export type DomainEvent =
  | PriceFetchedEvent
  | PriceAggregatedEvent
  | PricePublishedEvent
  | AnomalyDetectedEvent
  | SourceDegradedEvent
  | SlaBreachEvent
  | ContractEventDecodedEvent
  | ContractEventDecodeFailedEvent;

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

export interface SlaBreachEvent {
  type: 'sla_breach';
  payload: {
    source: string;
    asset: string;
    elapsedSeconds: number;
    thresholdSeconds: number;
  };
  timestamp: number;
}

/**
 * Emitted when a raw Soroban contract event is successfully decoded into a
 * typed record. `event` is the typed record produced by the decoding library
 * in `@refract/types`; `version` is the contract event schema version that was
 * validated against `SUPPORTED_CONTRACT_EVENT_VERSIONS`.
 */
export interface ContractEventDecodedEvent {
  type: 'contract_event_decoded';
  payload: {
    event: DecodedContractEvent;
    version: number;
  };
  timestamp: number;
}

/**
 * Emitted when a raw contract event cannot be decoded or its version is not
 * supported. Consumers should treat this as an operational signal (monitoring
 * alert / dead-letter) rather than a hard failure of the ingest pipeline.
 */
export interface ContractEventDecodeFailedEvent {
  type: 'contract_event_decode_failed';
  payload: {
    reason: 'unsupported_version' | 'malformed';
    message: string;
    version?: number;
    supportedVersions: readonly number[];
    raw: unknown;
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

/**
 * Decode a raw Soroban contract event into a typed record and publish the
 * outcome on the domain event bus.
 *
 * - Success publishes `contract_event_decoded`.
 * - Unsupported versions publish `contract_event_decode_failed` with
 *   `reason: 'unsupported_version'`.
 * - Malformed payloads publish `contract_event_decode_failed` with
 *   `reason: 'malformed'`.
 *
 * Decode failures never throw; they are surfaced as domain events so the
 * ingest loop keeps running and failures are observable via monitoring.
 *
 * Compatibility: only versions listed in `SUPPORTED_CONTRACT_EVENT_VERSIONS`
 * are accepted. When the Soroban event schema is bumped, add the new version
 * to that list (and to the decoder) before rolling out the producing contract;
 * older versions remain supported until explicitly removed. Rollback: revert
 * the decoder/version list to the previous release; already-emitted
 * `contract_event_decode_failed` events remain valid and can be replayed.
 */
export function decodeAndPublishContractEvent(
  raw: unknown,
  bus: EventBus = eventBus,
  now: () => number = Date.now,
): DecodedContractEvent | undefined {
  try {
    const decoded = decodeContractEvent(raw);
    bus.publish({
      type: 'contract_event_decoded',
      payload: { event: decoded, version: decoded.version },
      timestamp: now(),
    });
    return decoded;
  } catch (err) {
    if (err instanceof ContractEventVersionError) {
      bus.publish({
        type: 'contract_event_decode_failed',
        payload: {
          reason: 'unsupported_version',
          message: err.message,
          version: err.version,
          supportedVersions: SUPPORTED_CONTRACT_EVENT_VERSIONS,
          raw,
        },
        timestamp: now(),
      });
    } else if (err instanceof ContractEventDecodeError) {
      bus.publish({
        type: 'contract_event_decode_failed',
        payload: {
          reason: 'malformed',
          message: err.message,
          supportedVersions: SUPPORTED_CONTRACT_EVENT_VERSIONS,
          raw,
        },
        timestamp: now(),
      });
    } else {
      bus.publish({
        type: 'contract_event_decode_failed',
        payload: {
          reason: 'malformed',
          message: err instanceof Error ? err.message : String(err),
          supportedVersions: SUPPORTED_CONTRACT_EVENT_VERSIONS,
          raw,
        },
        timestamp: now(),
      });
    }
    return undefined;
  }
}
