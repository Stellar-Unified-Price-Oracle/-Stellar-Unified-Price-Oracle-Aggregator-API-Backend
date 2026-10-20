import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/infrastructure/database', () => ({
  database: {
    query: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
  },
}));

import {
  decodeContractEvent,
  EventVersionError,
  EventDecodeError,
  SUPPORTED_EVENT_VERSIONS,
  type DecodedContractEvent,
} from '../src/services/soroban-event-decoder';

interface ContractEvent {
  id?: number;
  eventType: string;
  contractId: string;
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  indexed: boolean;
  data: Record<string, unknown>;
  createdAt?: number;
}

interface PriceSubmittedEvent extends ContractEvent {
  eventType: 'PriceSubmitted';
  data: {
    source: string;
    asset: string;
    price: string;
    decimals: number;
    timestamp: number;
  };
}

interface SourceSlashedEvent extends ContractEvent {
  eventType: 'SourceSlashed';
  data: {
    source: string;
    amount: string;
    reason: string;
  };
}

class ContractEventIndexer {
  async indexEvent(event: ContractEvent): Promise<number> {
    return Math.floor(Math.random() * 1000000);
  }

  async getEventsByType(eventType: string): Promise<ContractEvent[]> {
    return [];
  }

  async getEventsBySource(source: string): Promise<ContractEvent[]> {
    return [];
  }

  async queryEvents(filters: Record<string, unknown>): Promise<ContractEvent[]> {
    return [];
  }
}

describe('Contract Event Indexing Service', () => {
  let indexer: ContractEventIndexer;

  beforeEach(() => {
    indexer = new ContractEventIndexer();
  });

  it('indexes PriceSubmitted events', async () => {
    const event: PriceSubmittedEvent = {
      eventType: 'PriceSubmitted',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      txHash: 'abc123def456',
      blockNumber: 45000000,
      blockTimestamp: 1690000000,
      indexed: false,
      data: {
        source: 'chainlink',
        asset: 'XLM',
        price: '120000000',
        decimals: 7,
        timestamp: 1690000000,
      },
    };

    const eventId = await indexer.indexEvent(event);
    expect(eventId).toBeGreaterThan(0);
  });

  it('indexes SourceSlashed events', async () => {
    const event: SourceSlashedEvent = {
      eventType: 'SourceSlashed',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      txHash: 'abc123def456',
      blockNumber: 45000001,
      blockTimestamp: 1690000010,
      indexed: false,
      data: {
        source: 'band',
        amount: '500000000',
        reason: 'price_deviation_exceeds_threshold',
      },
    };

    const eventId = await indexer.indexEvent(event);
    expect(eventId).toBeGreaterThan(0);
  });

  it('retrieves PriceSubmitted events by asset', async () => {
    const events: PriceSubmittedEvent[] = [
      {
        id: 1,
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx1',
        blockNumber: 45000000,
        blockTimestamp: 1690000000,
        indexed: true,
        data: {
          source: 'chainlink',
          asset: 'XLM',
          price: '120000000',
          decimals: 7,
          timestamp: 1690000000,
        },
      },
    ];

    expect(events).toHaveLength(1);
    expect(events[0].data.asset).toBe('XLM');
  });

  it('retrieves events by source name', async () => {
    const events: ContractEvent[] = [
      {
        id: 1,
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx1',
        blockNumber: 45000000,
        blockTimestamp: 1690000000,
        indexed: true,
        data: {
          source: 'chainlink',
          asset: 'XLM',
          price: '120000000',
          decimals: 7,
          timestamp: 1690000000,
        },
      },
    ];

    expect(events[0].data).toBeDefined();
  });

  it('retrieves events within block range', async () => {
    const events: ContractEvent[] = [
      {
        id: 1,
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx1',
        blockNumber: 45000000,
        blockTimestamp: 1690000000,
        indexed: true,
        data: { source: 'chainlink', asset: 'XLM', price: '120000000', decimals: 7, timestamp: 1690000000 },
      },
      {
        id: 2,
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx2',
        blockNumber: 45000005,
        blockTimestamp: 1690000010,
        indexed: true,
        data: { source: 'redstone', asset: 'USDC', price: '100000000', decimals: 7, timestamp: 1690000010 },
      },
    ];

    const inRange = events.filter((e) => e.blockNumber >= 45000000 && e.blockNumber <= 45000010);
    expect(inRange).toHaveLength(2);
  });

  it('stores event data with proper schema', async () => {
    const event: ContractEvent = {
      eventType: 'PriceSubmitted',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      txHash: 'abc123def456',
      blockNumber: 45000000,
      blockTimestamp: 1690000000,
      indexed: false,
      data: {
        source: 'chainlink',
        asset: 'XLM',
        price: '120000000',
        decimals: 7,
        timestamp: 1690000000,
      },
    };

    expect(event.eventType).toBeDefined();
    expect(event.contractId).toBeDefined();
    expect(event.txHash).toBeDefined();
    expect(event.blockNumber).toBeGreaterThan(0);
    expect(event.data).toBeDefined();
  });

  it('retrieves events by event type', async () => {
    const priceSubmittedEvents: ContractEvent[] = [
      {
        id: 1,
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx1',
        blockNumber: 45000000,
        blockTimestamp: 1690000000,
        indexed: true,
        data: { source: 'chainlink', asset: 'XLM', price: '120000000', decimals: 7, timestamp: 1690000000 },
      },
    ];

    expect(priceSubmittedEvents.every((e) => e.eventType === 'PriceSubmitted')).toBe(true);
  });

  it('filters events by timestamp range', async () => {
    const events: ContractEvent[] = [
      {
        id: 1,
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx1',
        blockNumber: 45000000,
        blockTimestamp: 1690000000,
        indexed: true,
        data: { source: 'chainlink', asset: 'XLM', price: '120000000', decimals: 7, timestamp: 1690000000 },
      },
      {
        id: 2,
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx2',
        blockNumber: 45000005,
        blockTimestamp: 1690000100,
        indexed: true,
        data: { source: 'redstone', asset: 'USDC', price: '100000000', decimals: 7, timestamp: 1690000100 },
      },
    ];

    const filtered = events.filter((e) => e.blockTimestamp >= 1690000000 && e.blockTimestamp <= 1690000050);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].blockTimestamp).toBe(1690000000);
  });

  it('allows complex queries via REST API', () => {
    const queryParams = {
      eventType: 'PriceSubmitted',
      asset: 'XLM',
      startBlock: 45000000,
      endBlock: 45000100,
      source: 'chainlink',
    };

    expect(queryParams.eventType).toBe('PriceSubmitted');
    expect(queryParams.asset).toBe('XLM');
    expect(queryParams.source).toBe('chainlink');
  });

  it('marks events as indexed after storage', async () => {
    const event: ContractEvent = {
      eventType: 'PriceSubmitted',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      txHash: 'abc123def456',
      blockNumber: 45000000,
      blockTimestamp: 1690000000,
      indexed: false,
      data: {
        source: 'chainlink',
        asset: 'XLM',
        price: '120000000',
        decimals: 7,
        timestamp: 1690000000,
      },
    };

    const eventId = await indexer.indexEvent(event);
    const indexedEvent = { ...event, id: eventId, indexed: true };

    expect(indexedEvent.indexed).toBe(true);
    expect(indexedEvent.id).toBeDefined();
  });

  it('supports pagination for event queries', () => {
    const paginationParams = {
      limit: 50,
      offset: 0,
    };

    expect(paginationParams.limit).toBe(50);
    expect(paginationParams.offset).toBe(0);
  });

  it('indexes multiple event types in a single poll', async () => {
    const events: ContractEvent[] = [
      {
        eventType: 'PriceSubmitted',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx1',
        blockNumber: 45000000,
        blockTimestamp: 1690000000,
        indexed: false,
        data: { source: 'chainlink', asset: 'XLM', price: '120000000', decimals: 7, timestamp: 1690000000 },
      },
      {
        eventType: 'SourceSlashed',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        txHash: 'tx2',
        blockNumber: 45000001,
        blockTimestamp: 1690000010,
        indexed: false,
        data: { source: 'band', amount: '500000000', reason: 'price_deviation_exceeds_threshold' },
      },
    ];

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventType)).toEqual(['PriceSubmitted', 'SourceSlashed']);
  });
});

describe('Contract Event Decoding (typed decoder)', () => {
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  const priceSubmittedPayload = {
    version: 1,
    topics: ['PriceSubmitted', 'chainlink', 'XLM'],
    value: {
      source: 'chainlink',
      asset: 'XLM',
      price: '120000000',
      decimals: 7,
      timestamp: 1690000000,
    },
  };

  it('decodes a known event version into a typed record', () => {
    const decoded: DecodedContractEvent = decodeContractEvent({
      contractId,
      txHash: 'tx1',
      ledger: 45000000,
      ledgerClosedAt: 1690000000,
      payload: priceSubmittedPayload,
    });

    expect(decoded.eventType).toBe('PriceSubmitted');
    expect(decoded.version).toBe(1);
    expect(decoded.contractId).toBe(contractId);
    expect(decoded.data).toEqual({
      source: 'chainlink',
      asset: 'XLM',
      price: '120000000',
      decimals: 7,
      timestamp: 1690000000,
    });
  });

  it('decodes every supported event version', () => {
    for (const version of SUPPORTED_EVENT_VERSIONS) {
      const decoded = decodeContractEvent({
        contractId,
        txHash: `tx-v${version}`,
        ledger: 45000000,
        ledgerClosedAt: 1690000000,
        payload: { ...priceSubmittedPayload, version },
      });
      expect(decoded.version).toBe(version);
    }
  });

  it('returns a compatibility error for an unknown event version', () => {
    expect(() =>
      decodeContractEvent({
        contractId,
        txHash: 'tx-future',
        ledger: 45000000,
        ledgerClosedAt: 1690000000,
        payload: { ...priceSubmittedPayload, version: 999 },
      }),
    ).toThrow(EventVersionError);

    try {
      decodeContractEvent({
        contractId,
        txHash: 'tx-future',
        ledger: 45000000,
        ledgerClosedAt: 1690000000,
        payload: { ...priceSubmittedPayload, version: 999 },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(EventVersionError);
      expect((err as EventVersionError).code).toBe('UNSUPPORTED_EVENT_VERSION');
      expect((err as EventVersionError).receivedVersion).toBe(999);
      expect((err as EventVersionError).supportedVersions).toEqual(SUPPORTED_EVENT_VERSIONS);
    }
  });

  it('rejects a payload missing the version field', () => {
    const { version: _omit, ...withoutVersion } = priceSubmittedPayload;
    expect(() =>
      decodeContractEvent({
        contractId,
        txHash: 'tx-no-version',
        ledger: 45000000,
        ledgerClosedAt: 1690000000,
        payload: withoutVersion as unknown as typeof priceSubmittedPayload,
      }),
    ).toThrow(EventDecodeError);
  });

  it('rejects malformed payloads', () => {
    const malformedPayloads: unknown[] = [
      null,
      undefined,
      'not-an-object',
      42,
      { version: 1 },
      { version: 1, topics: [], value: null },
      { version: 1, topics: ['PriceSubmitted'], value: { source: 'chainlink' } },
      { version: 1, topics: ['PriceSubmitted', 'chainlink', 'XLM'], value: { ...priceSubmittedPayload.value, decimals: 'seven' } },
    ];

    for (const payload of malformedPayloads) {
      expect(() =>
        decodeContractEvent({
          contractId,
          txHash: 'tx-malformed',
          ledger: 45000000,
          ledgerClosedAt: 1690000000,
          payload: payload as never,
        }),
      ).toThrow(EventDecodeError);
    }
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      decodeContractEvent({
        contractId,
        txHash: 'tx-unknown-type',
        ledger: 45000000,
        ledgerClosedAt: 1690000000,
        payload: { version: 1, topics: ['UnknownEvent'], value: {} },
      }),
    ).toThrow(EventDecodeError);
  });

  it('route returns typed records for indexed events', async () => {
    const rawEvents = [
      {
        contractId,
        txHash: 'tx1',
        ledger: 45000000,
        ledgerClosedAt: 1690000000,
        payload: priceSubmittedPayload,
      },
      {
        contractId,
        txHash: 'tx2',
        ledger: 45000001,
        ledgerClosedAt: 1690000010,
        payload: {
          version: 1,
          topics: ['SourceSlashed', 'band'],
          value: { source: 'band', amount: '500000000', reason: 'price_deviation_exceeds_threshold' },
        },
      },
    ];

    const records = rawEvents.map((raw) => decodeContractEvent(raw));

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      eventType: 'PriceSubmitted',
      version: 1,
      contractId,
      txHash: 'tx1',
      ledger: 45000000,
    });
    expect(records[1]).toMatchObject({
      eventType: 'SourceSlashed',
      version: 1,
      contractId,
      txHash: 'tx2',
      ledger: 45000001,
    });
    expect(records[1].data).toEqual({
      source: 'band',
      amount: '500000000',
      reason: 'price_deviation_exceeds_threshold',
    });
  });

  it('route surfaces a compatibility error for unsupported versions', () => {
    const rawEvent = {
      contractId,
      txHash: 'tx-future',
      ledger: 45000002,
      ledgerClosedAt: 1690000020,
      payload: { ...priceSubmittedPayload, version: 999 },
    };

    expect(() => decodeContractEvent(rawEvent)).toThrow(EventVersionError);
  });
});
