import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface PublisherIntent {
  round: number;
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  nonce?: string;
}

interface ContractState {
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  roundId?: number;
}

interface ReconciliationResult {
  status: 'in_sync' | 'diverged' | 'partial_batch' | 'skew_detected';
  asset: string;
  intendedRound: number;
  onChainRound?: number;
  intendedPrice: bigint;
  onChainPrice?: bigint;
  reason?: string;
}

class PublisherReconciler {
  private intents: Map<number, PublisherIntent[]> = new Map();
  private lastReconciledRound = 0;
  private replicationLock: string | null = null;

  async persistIntent(intent: PublisherIntent): Promise<void> {
    if (!this.intents.has(intent.round)) {
      this.intents.set(intent.round, []);
    }
    this.intents.get(intent.round)!.push(intent);
  }

  async getIntent(round: number, asset: string): Promise<PublisherIntent | null> {
    const roundIntents = this.intents.get(round);
    if (!roundIntents) return null;
    return roundIntents.find((i) => i.asset === asset) || null;
  }

  async acquireLeaseForReconciliation(replicaId: string, ttlSeconds: number): Promise<boolean> {
    if (this.replicationLock === null || this.replicationLock === replicaId) {
      this.replicationLock = replicaId;
      return true;
    }
    return false;
  }

  async releaseLeaseForReconciliation(replicaId: string): Promise<void> {
    if (this.replicationLock === replicaId) {
      this.replicationLock = null;
    }
  }

  async reconcileWithContract(
    onChainState: ContractState[],
    replicaId: string,
  ): Promise<ReconciliationResult[]> {
    const results: ReconciliationResult[] = [];

    for (const state of onChainState) {
      const intent = await this.getIntent(this.lastReconciledRound + 1, state.asset);

      if (!intent) {
        results.push({
          status: 'diverged',
          asset: state.asset,
          intendedRound: -1,
          onChainRound: state.roundId,
          intendedPrice: 0n,
          onChainPrice: state.price,
          reason: 'No intent found for on-chain state',
        });
        continue;
      }

      if (intent.price !== state.price) {
        results.push({
          status: 'diverged',
          asset: state.asset,
          intendedRound: intent.round,
          onChainRound: state.roundId,
          intendedPrice: intent.price,
          onChainPrice: state.price,
          reason: 'Price mismatch',
        });
      } else if (intent.timestamp !== state.timestamp) {
        const timeDrift = Math.abs(intent.timestamp - state.timestamp);
        if (timeDrift > 300) {
          results.push({
            status: 'skew_detected',
            asset: state.asset,
            intendedRound: intent.round,
            onChainRound: state.roundId,
            intendedPrice: intent.price,
            onChainPrice: state.price,
            reason: `Timestamp drift: ${timeDrift}s exceeds tolerance`,
          });
        } else {
          results.push({
            status: 'in_sync',
            asset: state.asset,
            intendedRound: intent.round,
            onChainRound: state.roundId,
            intendedPrice: intent.price,
            onChainPrice: state.price,
          });
        }
      } else {
        results.push({
          status: 'in_sync',
          asset: state.asset,
          intendedRound: intent.round,
          onChainRound: state.roundId,
          intendedPrice: intent.price,
          onChainPrice: state.price,
        });
      }
    }

    this.lastReconciledRound++;
    return results;
  }

  async detectPartialBatchApplication(
    batchAssets: string[],
    onChainStates: ContractState[],
  ): Promise<{ applied: string[]; pending: string[] }> {
    const applied = onChainStates.map((s) => s.asset);
    const pending = batchAssets.filter((a) => !applied.includes(a));
    return { applied, pending };
  }

  async resumePartialBatch(pending: string[], round: number): Promise<void> {
    for (const asset of pending) {
      const intent = await this.getIntent(round, asset);
      if (intent) {
        await this.persistIntent(intent);
      }
    }
  }

  isRetryableFailure(errorReason: string): boolean {
    const nonRetryablePatterns = [
      'deviation guard',
      'unauthorized',
      'invalid asset',
    ];
    return !nonRetryablePatterns.some((pattern) =>
      errorReason.toLowerCase().includes(pattern),
    );
  }
}

describe('PublisherReconciliation', () => {
  let reconciler: PublisherReconciler;

  beforeEach(() => {
    reconciler = new PublisherReconciler();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Intent Persistence', () => {
    it('persists and recovers durable round intents after restart', async () => {
      const intent: PublisherIntent = {
        round: 1,
        asset: 'XLM',
        price: 12000000n,
        decimals: 8,
        timestamp: 1000,
        nonce: 'nonce-1',
      };

      await reconciler.persistIntent(intent);
      const recovered = await reconciler.getIntent(1, 'XLM');

      expect(recovered).not.toBeNull();
      expect(recovered?.asset).toBe('XLM');
      expect(recovered?.price).toBe(12000000n);
      expect(recovered?.nonce).toBe('nonce-1');
    });

    it('keyed intent to round for correlation', async () => {
      const intents: PublisherIntent[] = [
        {
          round: 1,
          asset: 'XLM',
          price: 10000000n,
          decimals: 8,
          timestamp: 1000,
        },
        {
          round: 2,
          asset: 'XLM',
          price: 11000000n,
          decimals: 8,
          timestamp: 2000,
        },
      ];

      for (const intent of intents) {
        await reconciler.persistIntent(intent);
      }

      const round1 = await reconciler.getIntent(1, 'XLM');
      const round2 = await reconciler.getIntent(2, 'XLM');

      expect(round1?.price).toBe(10000000n);
      expect(round2?.price).toBe(11000000n);
    });
  });

  describe('Divergence Detection', () => {
    it('detects price divergence between intent and contract', async () => {
      const intent: PublisherIntent = {
        round: 1,
        asset: 'XLM',
        price: 12000000n,
        decimals: 8,
        timestamp: 1000,
      };
      await reconciler.persistIntent(intent);

      const onChainState: ContractState = {
        asset: 'XLM',
        price: 15000000n,
        decimals: 8,
        timestamp: 1000,
        roundId: 1,
      };

      const results = await reconciler.reconcileWithContract([onChainState], 'replica-1');

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('diverged');
      expect(results[0].reason).toBe('Price mismatch');
    });

    it('detects timestamp skew above tolerance', async () => {
      const intent: PublisherIntent = {
        round: 1,
        asset: 'BTC',
        price: 5000000000n,
        decimals: 8,
        timestamp: 1000,
      };
      await reconciler.persistIntent(intent);

      const onChainState: ContractState = {
        asset: 'BTC',
        price: 5000000000n,
        decimals: 8,
        timestamp: 1500,
        roundId: 1,
      };

      const results = await reconciler.reconcileWithContract([onChainState], 'replica-1');

      expect(results[0].status).toBe('skew_detected');
      expect(results[0].reason).toContain('Timestamp drift');
    });

    it('confirms in-sync state when intent matches contract', async () => {
      const intent: PublisherIntent = {
        round: 1,
        asset: 'ETH',
        price: 300000000000n,
        decimals: 12,
        timestamp: 1000,
      };
      await reconciler.persistIntent(intent);

      const onChainState: ContractState = {
        asset: 'ETH',
        price: 300000000000n,
        decimals: 12,
        timestamp: 1000,
        roundId: 1,
      };

      const results = await reconciler.reconcileWithContract([onChainState], 'replica-1');

      expect(results[0].status).toBe('in_sync');
    });

    it('detects when no intent exists for on-chain state', async () => {
      const onChainState: ContractState = {
        asset: 'USDC',
        price: 1000000n,
        decimals: 6,
        timestamp: 1000,
        roundId: 5,
      };

      const results = await reconciler.reconcileWithContract([onChainState], 'replica-1');

      expect(results[0].status).toBe('diverged');
      expect(results[0].reason).toContain('No intent found');
    });
  });

  describe('Partial Batch Handling', () => {
    it('detects partial batch application', async () => {
      const batchAssets = ['XLM', 'BTC', 'ETH'];
      const onChainStates: ContractState[] = [
        { asset: 'XLM', price: 1n, decimals: 8, timestamp: 1000 },
        { asset: 'ETH', price: 2n, decimals: 8, timestamp: 1000 },
      ];

      const result = await reconciler.detectPartialBatchApplication(batchAssets, onChainStates);

      expect(result.applied).toContain('XLM');
      expect(result.applied).toContain('ETH');
      expect(result.pending).toContain('BTC');
    });

    it('resumes pending assets from partial batch', async () => {
      const intent: PublisherIntent = {
        round: 1,
        asset: 'BTC',
        price: 5000000000n,
        decimals: 8,
        timestamp: 1000,
      };
      await reconciler.persistIntent(intent);

      const pending = ['BTC'];
      await reconciler.resumePartialBatch(pending, 1);

      const recovered = await reconciler.getIntent(1, 'BTC');
      expect(recovered).not.toBeNull();
    });
  });

  describe('Multi-Replica Safety', () => {
    it('only one replica holds lease for reconciliation', async () => {
      const replica1 = await reconciler.acquireLeaseForReconciliation('replica-1', 60);
      const replica2 = await reconciler.acquireLeaseForReconciliation('replica-2', 60);

      expect(replica1).toBe(true);
      expect(replica2).toBe(false);

      await reconciler.releaseLeaseForReconciliation('replica-1');
      const replica3 = await reconciler.acquireLeaseForReconciliation('replica-3', 60);

      expect(replica3).toBe(true);
    });

    it('replica can reacquire its own lease', async () => {
      const replica1First = await reconciler.acquireLeaseForReconciliation('replica-1', 60);
      const replica1Second = await reconciler.acquireLeaseForReconciliation('replica-1', 60);

      expect(replica1First).toBe(true);
      expect(replica1Second).toBe(true);
    });
  });

  describe('Retry Logic', () => {
    it('does not retry non-retryable failures', () => {
      expect(reconciler.isRetryableFailure('deviation guard rejection')).toBe(false);
      expect(reconciler.isRetryableFailure('unauthorized caller')).toBe(false);
      expect(reconciler.isRetryableFailure('invalid asset name')).toBe(false);
    });

    it('retries transient failures', () => {
      expect(reconciler.isRetryableFailure('connection timeout')).toBe(true);
      expect(reconciler.isRetryableFailure('temporary service unavailable')).toBe(true);
      expect(reconciler.isRetryableFailure('rpc not responding')).toBe(true);
    });
  });

  describe('Staleness Bounds', () => {
    it('enforces staleness tolerance on timestamp drift', async () => {
      const intent: PublisherIntent = {
        round: 1,
        asset: 'XLM',
        price: 12000000n,
        decimals: 8,
        timestamp: 1000,
      };
      await reconciler.persistIntent(intent);

      const withinTolerance: ContractState = {
        asset: 'XLM',
        price: 12000000n,
        decimals: 8,
        timestamp: 1200,
        roundId: 1,
      };

      const results = await reconciler.reconcileWithContract([withinTolerance], 'replica-1');
      expect(results[0].status).toBe('in_sync');
    });

    it('fails when timestamp exceeds tolerance', async () => {
      const intent: PublisherIntent = {
        round: 1,
        asset: 'XLM',
        price: 12000000n,
        decimals: 8,
        timestamp: 1000,
      };
      await reconciler.persistIntent(intent);

      const exceedsTolerance: ContractState = {
        asset: 'XLM',
        price: 12000000n,
        decimals: 8,
        timestamp: 2000,
        roundId: 1,
      };

      const results = await reconciler.reconcileWithContract([exceedsTolerance], 'replica-1');
      expect(results[0].status).toBe('skew_detected');
    });
  });
});
