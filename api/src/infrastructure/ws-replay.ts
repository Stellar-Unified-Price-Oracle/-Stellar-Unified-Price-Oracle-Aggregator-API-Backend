/**
 * Bounded WebSocket replay support (issue #606).
 *
 * Replay is a bounded operation: a request can never return more than a fixed
 * number of messages or bytes, and a connection cannot request it more than a
 * fixed number of times per window. Buffer retention is bounded across assets
 * as well as within one asset, so the buffer set has a known memory ceiling.
 *
 * Sequence model: `sequenceId` is a single monotonically increasing counter for
 * the whole server. Buffers are per asset but sequence ids are global, so a
 * client resumes from one cursor and filters by asset; gaps in a filtered view
 * are expected and are not data loss.
 */

export interface BufferedMessage {
  sequenceId: number;
  asset: string;
  timestamp: number;
  data: unknown;
}

export interface ReplayBounds {
  maxMessages: number;
  maxBytes: number;
}

/**
 * Policy scope applied to a replay request (issue #748).
 *
 * A replay request is only served when the requesting credential's scope
 * permits the asset (feed scope), the operation (`replay`), the current
 * environment, and has not expired. Assets outside the scope are never
 * returned, even when the caller asks for them explicitly.
 */
export interface ReplayScope {
  /** Assets the credential may read. `null` means all assets. */
  feeds: string[] | null;
  /** Operations the credential may perform. */
  operations: string[];
  /** Environment the credential is bound to. */
  environment: string;
  /** Epoch millis after which the credential is no longer valid. */
  expiresAt: number | null;
}

export type ReplayScopeDenial =
  | 'operation_not_permitted'
  | 'environment_mismatch'
  | 'expired'
  | 'asset_not_permitted';

export interface ReplayScopeDecision {
  allowed: boolean;
  reason?: ReplayScopeDenial;
}

export function evaluateReplayScope(
  scope: ReplayScope,
  environment: string,
  now: number = Date.now(),
): ReplayScopeDecision {
  if (!scope.operations.includes('replay')) {
    return { allowed: false, reason: 'operation_not_permitted' };
  }
  if (scope.environment !== environment) {
    return { allowed: false, reason: 'environment_mismatch' };
  }
  if (scope.expiresAt !== null && now >= scope.expiresAt) {
    return { allowed: false, reason: 'expired' };
  }
  return { allowed: true };
}

export function isAssetPermitted(scope: ReplayScope, asset: string): boolean {
  return scope.feeds === null || scope.feeds.includes(asset);
}

export interface ReplayWindow {
  messages: BufferedMessage[];
  /** True when the request wanted more than the bounds allowed. */
  truncated: boolean;
  /** Messages matching the cursor that were not delivered. */
  remaining: number;
  bytes: number;
}

export interface ReplayBufferStats {
  assets: number;
  messages: number;
  bytes: number;
}

function messageBytes(message: BufferedMessage): number {
  return JSON.stringify(message.data ?? null).length + 64;
}

export function collectReplayWindow(
  sources: Iterable<BufferedMessage[]>,
  lastSequenceId: number,
  bounds: ReplayBounds,
  scope?: ReplayScope | null,
): ReplayWindow {
  const candidates: BufferedMessage[] = [];
  for (const buffer of sources) {
    for (const entry of buffer) {
      if (entry.sequenceId <= lastSequenceId) continue;
      if (scope && !isAssetPermitted(scope, entry.asset)) continue;
      candidates.push(entry);
    }
  }
  candidates.sort((a, b) => a.sequenceId - b.sequenceId);

  const messages: BufferedMessage[] = [];
  let bytes = 0;
  let index = 0;
  while (index < candidates.length) {
    const entry = candidates[index];
    const entryBytes = messageBytes(entry);
    if (messages.length >= bounds.maxMessages) break;
    if (bytes + entryBytes > bounds.maxBytes && messages.length > 0) break;
    messages.push(entry);
    bytes += entryBytes;
    index++;
  }

  const remaining = candidates.length - messages.length;
  return { messages, truncated: remaining > 0, remaining, bytes };
}

export class ReplayRateLimiter {
  private readonly hits: Map<string, number[]> = new Map();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  prune(now: number = Date.now()): void {
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}

export class ReplayBuffer {
  /** Insertion ordered: the first asset is the oldest. */
  private readonly buffers: Map<string, BufferedMessage[]> = new Map();
  private totalBytes = 0;
  private totalMessages = 0;

  constructor(
    private readonly maxAssets: number,
    private readonly messagesPerAsset: number,
    private readonly maxBytes: number,
  ) {}

  push(asset: string, entry: BufferedMessage): void {
    const existing = this.buffers.get(asset);
    if (existing) {
      this.buffers.delete(asset);
      this.buffers.set(asset, existing);
    } else {
      if (this.buffers.size >= this.maxAssets) this.evictOldestAsset();
      this.buffers.set(asset, []);
    }

    const buffer = this.buffers.get(asset)!;
    buffer.push(entry);
    this.totalMessages++;
    this.totalBytes += messageBytes(entry);

    while (buffer.length > this.messagesPerAsset) this.dropOldest(asset);
    while (this.totalBytes > this.maxBytes && this.totalMessages > 0) this.dropOldestFromOldestAsset();
  }

  sources(assets?: string[] | null, scope?: ReplayScope | null): BufferedMessage[][] {
    if (!assets) {
      const all = Array.from(this.buffers.values());
      if (!scope) return all;
      return all.map((buffer) => buffer.filter((entry) => isAssetPermitted(scope, entry.asset)));
    }
    return assets
      .filter((asset) => !scope || isAssetPermitted(scope, asset))
      .map((asset) => this.buffers.get(asset) ?? []);
  }

  has(asset: string): boolean {
    return this.buffers.has(asset);
  }

  stats(): ReplayBufferStats {
    return { assets: this.buffers.size, messages: this.totalMessages, bytes: this.totalBytes };
  }

  clear(): void {
    this.buffers.clear();
    this.totalBytes = 0;
    this.totalMessages = 0;
  }

  private dropOldest(asset: string): void {
    const buffer = this.buffers.get(asset);
    const dropped = buffer?.shift();
    if (!dropped) return;
    this.totalMessages--;
    this.totalBytes -= messageBytes(dropped);
  }

  private evictOldestAsset(): void {
    const oldest = this.buffers.keys().next();
    if (oldest.done) return;
    const buffer = this.buffers.get(oldest.value)!;
    for (const dropped of buffer) {
      this.totalMessages--;
      this.totalBytes -= messageBytes(dropped);
    }
    this.buffers.delete(oldest.value);
  }

  private dropOldestFromOldestAsset(): void {
    const oldest = this.buffers.keys().next();
    if (oldest.done) return;
    this.dropOldest(oldest.value);
    if (this.buffers.get(oldest.value)?.length === 0) this.buffers.delete(oldest.value);
  }
}
