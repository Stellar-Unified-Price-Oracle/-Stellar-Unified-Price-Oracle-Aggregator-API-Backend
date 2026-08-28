import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MerkleTree, BatchPriceEntry, MerkleBatch } from '../src/infrastructure/merkle';
import { AggregatedPrice } from '../src/infrastructure/types';

describe('Publisher Batch Submission with Merkle Tree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('MerkleTree', () => {
    it('should build tree from single entry', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const tree = new MerkleTree(entries);
      expect(tree.root).toBeDefined();
      expect(tree.root).toBeInstanceOf(Buffer);
    });

    it('should build tree from multiple entries', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'BTC',
          price: 4500000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'ETH',
          price: 230000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const tree = new MerkleTree(entries);
      expect(tree.root).toBeDefined();
      expect(tree.root.length).toBe(32);
    });

    it('should throw error for empty entries', () => {
      const entries: BatchPriceEntry[] = [];
      expect(() => new MerkleTree(entries)).toThrow('cannot build tree from empty entry list');
    });

    it('should generate valid proofs for all entries', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'BTC',
          price: 4500000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'ETH',
          price: 230000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'USDC',
          price: 100000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const tree = new MerkleTree(entries);

      for (let i = 0; i < entries.length; i++) {
        const proof = tree.getProof(i);
        expect(proof.leafIndex).toBe(i);
        expect(Array.isArray(proof.siblings)).toBe(true);
      }
    });

    it('should verify proofs for all entries', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'BTC',
          price: 4500000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'ETH',
          price: 230000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const tree = new MerkleTree(entries);

      for (let i = 0; i < entries.length; i++) {
        const proof = tree.getProof(i);
        const isValid = tree.verifyProof(entries[i], proof);
        expect(isValid).toBe(true);
      }
    });

    it('should reject invalid proofs', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'BTC',
          price: 4500000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const tree = new MerkleTree(entries);
      const proof = tree.getProof(0);

      const modifiedEntry: BatchPriceEntry = {
        asset: 'XLM',
        price: 13000000n,
        decimals: 8,
        timestamp: 1700000000,
        source: 'chainlink',
      };

      const isValid = tree.verifyProof(modifiedEntry, proof);
      expect(isValid).toBe(false);
    });

    it('should throw error for out of range leaf index', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const tree = new MerkleTree(entries);
      expect(() => tree.getProof(5)).toThrow('leafIndex 5 out of range');
    });
  });

  describe('MerkleBatch', () => {
    it('should build batch with root and proofs', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'BTC',
          price: 4500000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const batch = MerkleTree.build(entries);

      expect(batch.root).toBeDefined();
      expect(batch.entries).toEqual(entries);
      expect(batch.proofs.length).toBe(entries.length);
    });

    it('should have one proof per entry', () => {
      const entries: BatchPriceEntry[] = Array.from({ length: 10 }, (_, i) => ({
        asset: `ASSET${i}`,
        price: BigInt(1000000 + i),
        decimals: 8,
        timestamp: 1700000000 + i,
        source: 'chainlink',
      }));

      const batch = MerkleTree.build(entries);

      expect(batch.proofs.length).toBe(10);
      expect(batch.entries.length).toBe(10);
    });

    it('should verify all proofs in batch', () => {
      const entries: BatchPriceEntry[] = [
        {
          asset: 'XLM',
          price: 12000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'BTC',
          price: 4500000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
        {
          asset: 'ETH',
          price: 230000000000n,
          decimals: 8,
          timestamp: 1700000000,
          source: 'chainlink',
        },
      ];

      const batch = MerkleTree.build(entries);
      const tree = new MerkleTree(entries);

      for (let i = 0; i < batch.entries.length; i++) {
        const isValid = tree.verifyProof(batch.entries[i], batch.proofs[i]);
        expect(isValid).toBe(true);
      }
    });
  });

  describe('Batch Submission Pattern', () => {
    it('should demonstrate batch submission with 5 prices', () => {
      const prices: AggregatedPrice[] = [
        { asset: 'XLM', price: '12000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink', 'redstone'] },
        { asset: 'BTC', price: '4500000000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
        { asset: 'ETH', price: '230000000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
        { asset: 'USDC', price: '100000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
        { asset: 'USDT', price: '99999999', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
      ];

      const batchEntries: BatchPriceEntry[] = prices.map((p) => ({
        asset: p.asset,
        price: BigInt(p.price),
        decimals: p.decimals,
        timestamp: p.timestamp,
        source: 'aggregated',
      }));

      const batch = MerkleTree.build(batchEntries);

      expect(batch.root).toBeDefined();
      expect(batch.proofs.length).toBe(5);
      expect(batch.root.length).toBe(32);
    });

    it('should use single merkle root instead of individual submissions', () => {
      const prices: AggregatedPrice[] = [
        { asset: 'XLM', price: '12000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
        { asset: 'BTC', price: '4500000000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
        { asset: 'ETH', price: '230000000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
      ];

      const batchEntries: BatchPriceEntry[] = prices.map((p) => ({
        asset: p.asset,
        price: BigInt(p.price),
        decimals: p.decimals,
        timestamp: p.timestamp,
        source: 'aggregated',
      }));

      const batch = MerkleTree.build(batchEntries);

      // With batch submission:
      // - 1 commit_batch call with merkle root
      // - 3 apply_batch_entry calls with proofs
      // Total: 4 contract calls instead of 3 individual submit_price calls

      expect(batch.root).toBeDefined();
      expect(batch.proofs.length).toBe(prices.length);

      // Verify root is consistent across multiple builds
      const batch2 = MerkleTree.build(batchEntries);
      expect(batch.root).toEqual(batch2.root);
    });

    it('should handle odd-length entries in batch', () => {
      const prices: AggregatedPrice[] = [
        { asset: 'XLM', price: '12000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
        { asset: 'BTC', price: '4500000000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
        { asset: 'ETH', price: '230000000000', decimals: 8, timestamp: 1700000000, sources: ['chainlink'] },
      ];

      const batchEntries: BatchPriceEntry[] = prices.map((p) => ({
        asset: p.asset,
        price: BigInt(p.price),
        decimals: p.decimals,
        timestamp: p.timestamp,
        source: 'aggregated',
      }));

      const batch = MerkleTree.build(batchEntries);

      expect(batch.root).toBeDefined();
      expect(batch.proofs.length).toBe(3);

      // Verify all proofs
      const tree = new MerkleTree(batchEntries);
      for (let i = 0; i < batch.entries.length; i++) {
        expect(tree.verifyProof(batch.entries[i], batch.proofs[i])).toBe(true);
      }
    });
  });
});
