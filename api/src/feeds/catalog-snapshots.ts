import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { FeedPolicy } from './feed-policy';
import type { FeedLifecycleEntry } from './feed-lifecycle';
import type { FeedAliasEntry } from './feed-aliases';

export interface FeedCatalogSnapshot {
  id: string;
  version: number;
  createdAt: string;
  feeds: Array<{ policy: FeedPolicy; lifecycle: FeedLifecycleEntry | null }>;
  aliases: FeedAliasEntry[];
  assetAliases: Array<{ alias: string; canonicalId: string }>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class FeedCatalogSnapshotStore {
  private readonly snapshots = new Map<string, FeedCatalogSnapshot>();
  private nextVersion = 1;

  create(input: { policies: FeedPolicy[]; lifecycle: (feedId: string) => FeedLifecycleEntry | undefined; aliases: FeedAliasEntry[]; assetAliases?: Array<{ alias: string; canonicalId: string }> }, createdAt = new Date().toISOString()): FeedCatalogSnapshot {
    const feeds = input.policies.slice().sort((a, b) => a.feedId.localeCompare(b.feedId)).map((policy) => ({
      policy: JSON.parse(JSON.stringify(policy)) as FeedPolicy,
      lifecycle: input.lifecycle(policy.feedId) ? JSON.parse(JSON.stringify(input.lifecycle(policy.feedId))) as FeedLifecycleEntry : null,
    }));
    const aliases = input.aliases.slice().sort((a, b) => a.alias.localeCompare(b.alias)).map((alias) => JSON.parse(JSON.stringify(alias)) as FeedAliasEntry);
    const assetAliases = (input.assetAliases ?? []).slice().sort((a, b) => a.alias.localeCompare(b.alias)).map((alias) => ({ ...alias }));
    const version = this.nextVersion++;
    const digest = createHash('sha256').update(stableJson({ version, feeds, aliases, assetAliases })).digest('hex');
    const snapshot = deepFreeze({ id: `fc-${version}-${digest}`, version, createdAt, feeds, aliases, assetAliases }) as FeedCatalogSnapshot;
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  get(id: string): FeedCatalogSnapshot | undefined { return this.snapshots.get(id); }
  list(): FeedCatalogSnapshot[] { return [...this.snapshots.values()].sort((a, b) => b.version - a.version); }
}

export interface SignedCatalogRelease { snapshotId: string; signature: string; signedAt: string; }
export interface CatalogReleaseState { stable: SignedCatalogRelease | null; canary: SignedCatalogRelease | null; history: SignedCatalogRelease[]; }

export class CatalogReleaseManager {
  private stableRelease: SignedCatalogRelease | null = null;
  private canaryRelease: SignedCatalogRelease | null = null;
  private readonly history: SignedCatalogRelease[] = [];
  constructor(private readonly signingKey: string) {}

  sign(snapshotId: string, signedAt = new Date().toISOString()): SignedCatalogRelease {
    if (this.signingKey.length < 32) throw new Error('CATALOG_SIGNING_KEY must contain at least 32 characters');
    return { snapshotId, signature: createHmac('sha256', this.signingKey).update(`${snapshotId}\n${signedAt}`).digest('hex'), signedAt };
  }
  verify(release: SignedCatalogRelease): boolean {
    const expected = Buffer.from(this.sign(release.snapshotId, release.signedAt).signature, 'hex');
    const actual = Buffer.from(release.signature, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  stageCanary(release: SignedCatalogRelease): boolean {
    if (!this.verify(release)) return false;
    this.canaryRelease = { ...release };
    return true;
  }
  promoteCanary(): boolean {
    if (!this.canaryRelease || !this.verify(this.canaryRelease)) return false;
    this.stableRelease = this.canaryRelease;
    this.history.push(this.stableRelease);
    this.canaryRelease = null;
    return true;
  }
  rollback(snapshotId: string, signature: string): boolean {
    const prior = this.history.find((release) => release.snapshotId === snapshotId && release.signature === signature);
    if (!prior || !this.verify(prior)) return false;
    this.stableRelease = prior;
    this.canaryRelease = null;
    this.history.push(prior);
    return true;
  }
  compare(snapshotId: string, candidate?: FeedCatalogSnapshot, stable?: FeedCatalogSnapshot) {
    const stableSnapshotId = this.stableRelease?.snapshotId ?? null;
    if (!candidate || !stable) return { snapshotId, stableSnapshotId, matchesStable: stableSnapshotId === snapshotId, changedFeeds: [], addedFeeds: [], removedFeeds: [], lifecycleChanged: [], aliasesChanged: false, assetAliasesChanged: false };
    const stableFeeds = new Map(stable.feeds.map(({ policy, lifecycle }) => [policy.feedId, stableJson({ policy, lifecycle: lifecycle?.state ?? null })]));
    const candidateFeeds = new Map(candidate.feeds.map(({ policy, lifecycle }) => [policy.feedId, stableJson({ policy, lifecycle: lifecycle?.state ?? null })]));
    return {
      snapshotId, stableSnapshotId, matchesStable: stableSnapshotId === snapshotId,
      changedFeeds: [...candidateFeeds.keys()].filter((id) => stableFeeds.has(id) && stableFeeds.get(id) !== candidateFeeds.get(id)).sort(),
      addedFeeds: [...candidateFeeds.keys()].filter((id) => !stableFeeds.has(id)).sort(),
      removedFeeds: [...stableFeeds.keys()].filter((id) => !candidateFeeds.has(id)).sort(),
      lifecycleChanged: candidate.feeds.filter(({ policy, lifecycle }) => {
        const oldFeed = stable.feeds.find((entry) => entry.policy.feedId === policy.feedId);
        return oldFeed && oldFeed.lifecycle?.state !== lifecycle?.state;
      }).map(({ policy }) => policy.feedId).sort(),
      aliasesChanged: stableJson(candidate.aliases) !== stableJson(stable.aliases),
      assetAliasesChanged: stableJson(candidate.assetAliases) !== stableJson(stable.assetAliases),
    };
  }
  state(): CatalogReleaseState {
    return {
      stable: this.stableRelease ? { ...this.stableRelease } : null,
      canary: this.canaryRelease ? { ...this.canaryRelease } : null,
      history: this.history.map((release) => ({ ...release })),
    };
  }
}
