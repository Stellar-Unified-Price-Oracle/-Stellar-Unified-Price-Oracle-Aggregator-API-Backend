import { createHash } from 'crypto';

export interface BatchPriceEntry {
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  source: string;
}

export interface MerkleProof {
  leafIndex: number;
  siblings: Buffer[];
}

export interface MerkleBatch {
  root: Buffer;
  batchSize: number;
  entries: BatchPriceEntry[];
  proofs: MerkleProof[];
}

/** Maximum co-path length accepted by proof verification (Issue #385) */
export const MAX_PROOF_SIBLINGS = 64;

/** Domain separation tag for leaf hashes (RFC 6962 / Issue #566) */
export const LEAF_DOMAIN_TAG = Buffer.from([0x00]);

/** Domain separation tag for internal node hashes (RFC 6962 / Issue #566) */
export const NODE_DOMAIN_TAG = Buffer.from([0x01]);

// Canonical leaf encoding mirrors the on-chain hash_leaf() in merkle.rs:
//   SHA-256(0x00 || asset_bytes || 0x00 || price_be16 || decimals_be4 || timestamp_be8 || source_bytes)
export function hashLeaf(entry: BatchPriceEntry): Buffer {
  const assetBytes = Buffer.from(entry.asset, 'utf8');
  const sep = Buffer.from([0x00]);

  const priceBuf = Buffer.allocUnsafe(16);
  // i128 big-endian: write as two u64s (high, low)
  const price = BigInt.asIntN(128, entry.price);
  const high = BigInt.asUintN(64, price >> 64n);
  const low = BigInt.asUintN(64, price & 0xffff_ffff_ffff_ffffn);
  priceBuf.writeBigUInt64BE(high, 0);
  priceBuf.writeBigUInt64BE(low, 8);

  const decBuf = Buffer.allocUnsafe(4);
  decBuf.writeUInt32BE(entry.decimals, 0);

  const tsBuf = Buffer.allocUnsafe(8);
  tsBuf.writeBigUInt64BE(BigInt(entry.timestamp), 0);

  const sourceBuf = Buffer.from(entry.source, 'utf8');

  const combined = Buffer.concat([LEAF_DOMAIN_TAG, assetBytes, sep, priceBuf, decBuf, tsBuf, sourceBuf]);
  return createHash('sha256').update(combined).digest();
}

export function hashPair(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([NODE_DOMAIN_TAG, left, right])).digest();
}

export class MerkleTree {
  private readonly leaves: Buffer[];
  // levels[0] = leaf hashes, levels[k] = level k hashes, last = [root]
  private readonly levels: Buffer[][];

  constructor(entries: BatchPriceEntry[]) {
    if (entries.length === 0) {
      throw new Error('MerkleTree: cannot build tree from empty entry list');
    }

    this.leaves = entries.map(hashLeaf);

    this.levels = [];
    let current = [...this.leaves];
    this.levels.push(current);

    // Odd-level rule: promote the last node unchanged (no duplication).
    // This matches the Rust compute_root/verify_proof behaviour and prevents
    // the duplicate-slot ambiguity fixed in issue #567.
    while (current.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        if (i + 1 < current.length) {
          const right = current[i + 1];
          next.push(hashPair(left, right));
        } else {
          // Promote last node at an odd-length level.
          next.push(left);
        }
      }
      this.levels.push(next);
      current = next;
    }
  }

  get root(): Buffer {
    return this.levels[this.levels.length - 1][0];
  }

  get size(): number {
    return this.leaves.length;
  }

  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`MerkleTree: leafIndex ${leafIndex} out of range`);
    }

    const siblings: Buffer[] = [];
    let index = leafIndex;

    for (let level = 0; level < this.levels.length - 1; level++) {
      const levelNodes = this.levels[level];
      const isLast = index === levelNodes.length - 1;
      const isOddLevel = levelNodes.length % 2 === 1;

      if (isLast && isOddLevel) {
        // Promoted node: no sibling emitted for this level.
      } else {
        const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
        siblings.push(levelNodes[siblingIndex]);
      }

      index = Math.floor(index / 2);
    }

    return { leafIndex, siblings };
  }

  verifyProof(entry: BatchPriceEntry, proof: MerkleProof): boolean {
    if (proof.siblings.length > MAX_PROOF_SIBLINGS) {
      return false;
    }

    let current = hashLeaf(entry);
    let index = proof.leafIndex;
    let levelSize = this.leaves.length;
    let sibCursor = 0;

    while (levelSize > 1) {
      const isLast = index === levelSize - 1;
      const isOddLevel = levelSize % 2 === 1;

      if (isLast && isOddLevel) {
        // Promoted: no sibling consumed.
      } else {
        if (sibCursor >= proof.siblings.length) return false;
        const sibling = proof.siblings[sibCursor++];
        current = index % 2 === 0 ? hashPair(current, sibling) : hashPair(sibling, current);
      }
      index = Math.floor(index / 2);
      levelSize = Math.ceil(levelSize / 2);
    }

    return current.equals(this.root);
  }

  static build(entries: BatchPriceEntry[]): MerkleBatch {
    const tree = new MerkleTree(entries);
    const proofs = entries.map((_, i) => tree.getProof(i));
    return {
      root: tree.root,
      batchSize: tree.size,
      entries,
      proofs,
    };
  }
}
