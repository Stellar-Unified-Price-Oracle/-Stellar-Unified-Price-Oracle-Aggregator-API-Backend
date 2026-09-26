import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Account, Keypair } from '@stellar/stellar-sdk';
import { ContractPublisher, DEFAULT_FEE_POLICY } from '../src/contract-publishing/publisher';
import { AggregatedPrice } from '../src/infrastructure/types';

describe('ContractPublisher — Sequence Management & Lifecycle (Issues #578, #574)', () => {
  let mockServer: any;
  let keypair: Keypair;
  let publisher: ContractPublisher;

  beforeEach(() => {
    keypair = Keypair.random();
    process.env.ADMIN_SECRET_KEY = keypair.secret();
    process.env.SOROBAN_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    // Mock Soroban RPC server
    let currentSeq = 100n;
    mockServer = {
      getAccount: vi.fn().mockImplementation(async () => {
        return new Account(keypair.publicKey(), (currentSeq++).toString());
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        minResourceFee: '150',
        results: [{}],
      }),
      sendTransaction: vi.fn().mockResolvedValue({
        status: 'PENDING',
        hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        fee: '200',
      }),
      getTransaction: vi.fn().mockResolvedValue({
        status: 'SUCCESS',
        resultMetaXdr: [],
      }),
    };

    publisher = new ContractPublisher();
    // Inject mock server
    (publisher as any).server = mockServer;
    (publisher as any).keypair = keypair;
  });

  afterEach(async () => {
    await publisher.shutdown();
    vi.restoreAllMocks();
  });

  it('reuses account sequence across multiple submissions in a round (bounded getAccount lookups)', async () => {
    const prices: AggregatedPrice[] = [
      { asset: 'XLM', price: '1200000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1 },
      { asset: 'USDC', price: '1000000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1 },
      { asset: 'BTC', price: '50000000000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1 },
      { asset: 'ETH', price: '3000000000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1 },
      { asset: 'EURC', price: '1080000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1 },
    ];

    await publisher.publishAggregated(prices);

    // Assert getAccount was called only ONCE for all 5 asset submissions
    expect(mockServer.getAccount).toHaveBeenCalledTimes(1);

    // Assert sendTransaction was called for each asset (5 times)
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(5);

    // Verify RPC call metrics for the round
    const roundMetrics = publisher.getRoundRpcMetrics();
    expect(roundMetrics.getAccount).toBe(1);
    expect(roundMetrics.send).toBe(5);
  });

  it('bypasses getAccount lookup during read-only staleness heartbeat simulation', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce({
      result: {
        retval: {
          _arm: 'obj',
          _value: {
            _arm: 'map',
            _value: [
              {
                key: { _arm: 'sym', _value: 'timestamp' },
                val: { _arm: 'u64', _value: 1700000000n },
              },
            ],
          },
        },
      },
    });

    const timestamp = await publisher.getOnChainTimestamp('XLM');
    expect(timestamp).toBeDefined();

    // getAccount must NOT be called for read-only simulation
    expect(mockServer.getAccount).toHaveBeenCalledTimes(0);
    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('recovers from tx_bad_seq by resyncing from getAccount and retrying once', async () => {
    // First sendTransaction rejects with tx_bad_seq
    mockServer.sendTransaction
      .mockRejectedValueOnce(new Error('Transaction simulation/submission failed: tx_bad_seq'))
      .mockResolvedValueOnce({
        status: 'SUCCESS',
        hash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        fee: '200',
      });

    const hash = await publisher.submitPrice('XLM', 1200000n, 7, 1700000000);

    expect(hash).toBeDefined();
    // 1 initial getAccount + 1 resync getAccount on bad sequence = 2
    expect(mockServer.getAccount).toHaveBeenCalledTimes(2);
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('enforces fee policy and rejects transactions when simulation minResourceFee exceeds threshold', async () => {
    const customPublisher = new ContractPublisher({
      maxResourceFee: 500, // strict 500 stroop ceiling
    });
    (customPublisher as any).server = mockServer;
    (customPublisher as any).keypair = keypair;

    mockServer.simulateTransaction.mockResolvedValueOnce({
      minResourceFee: '999999', // far above 500
      cost: { feeCharged: '999999' },
    });

    const hash = await customPublisher.submitPrice('XLM', 1200000n, 7, 1700000000);

    // Submission should be rejected without calling sendTransaction
    expect(hash).toBeNull();
    expect(mockServer.sendTransaction).not.toHaveBeenCalled();

    await customPublisher.shutdown();
  });

  it('preserves canary sequence and failure streak across rounds (process-scoped publisher)', async () => {
    const prices: AggregatedPrice[] = [
      { asset: 'XLM', price: '1200000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1 },
      { asset: 'USDC', price: '1000000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1 },
    ];

    // Round 1
    await publisher.publishAggregated(prices);
    expect(publisher.getSubmissionSequence()).toBe(2);

    // Round 2 (sequence continues monotonically instead of resetting to 0)
    await publisher.publishAggregated(prices);
    expect(publisher.getSubmissionSequence()).toBe(4);
  });

  it('drains retry queue cleanly on shutdown without leaving orphan timers', async () => {
    (publisher as any).retryQueue.enqueue({
      asset: 'XLM',
      price: 1200000n,
      decimals: 7,
      timestamp: 1700000000,
    });

    expect(publisher.getRetryQueueSize()).toBe(1);

    await publisher.shutdown();

    // After shutdown, queue should be drained
    expect(publisher.getRetryQueueSize()).toBe(0);
  });
});
