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
  entries: BatchPriceEntry[];
  proofs: MerkleProof[];
}

// Canonical leaf encoding mirrors the on-chain hash_leaf() in merkle.rs:
//   SHA-256(asset_bytes || 0x00 || price_be16 || decimals_be4 || timestamp_be8 || source_bytes)
function hashLeaf(entry: BatchPriceEntry): Buffer {
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

  const combined = Buffer.concat([assetBytes, sep, priceBuf, decBuf, tsBuf, sourceBuf]);
  return createHash('sha256').update(combined).digest();
}

function hashPair(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([left, right])).digest();
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

    while (current.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = i + 1 < current.length ? current[i + 1] : left; // duplicate last if odd
        next.push(hashPair(left, right));
      }
      this.levels.push(next);
      current = next;
    }
  }

  get root(): Buffer {
    return this.levels[this.levels.length - 1][0];
  }

  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`MerkleTree: leafIndex ${leafIndex} out of range`);
    }

    const siblings: Buffer[] = [];
    let index = leafIndex;

    for (let level = 0; level < this.levels.length - 1; level++) {
      const levelNodes = this.levels[level];
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;

      // If sibling is beyond the array (odd-length level), use the node itself
      const sibling =
        siblingIndex < levelNodes.length ? levelNodes[siblingIndex] : levelNodes[index];
      siblings.push(sibling);

      index = Math.floor(index / 2);
    }

    return { leafIndex, siblings };
  }

  verifyProof(entry: BatchPriceEntry, proof: MerkleProof): boolean {
    let current = hashLeaf(entry);
    let index = proof.leafIndex;

    for (const sibling of proof.siblings) {
      current =
        index % 2 === 0 ? hashPair(current, sibling) : hashPair(sibling, current);
      index = Math.floor(index / 2);
    }

    return current.equals(this.root);
  }

  static build(entries: BatchPriceEntry[]): MerkleBatch {
    const tree = new MerkleTree(entries);
    const proofs = entries.map((_, i) => tree.getProof(i));
    return {
      root: tree.root,
      entries,
      proofs,
    };
  }
}
