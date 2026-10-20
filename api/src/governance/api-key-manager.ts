import * as crypto from 'crypto';
import { logger } from '../observability/logger';
import { config } from '../infrastructure/config';
import type { Role } from './rbac';
import { decryptSecret } from './crypto';
import type { ApiKeyEntry } from '@stellar-oracle/vault-client';
import { TIER_RATE_LIMITS, effectiveTenantLimit, type RateTier } from '../platform/limit-model';
import { createTenantWindow, type TenantWindow } from '../platform/tenant-window';

export type KeyTier = RateTier;
export { TIER_RATE_LIMITS };

/**
 * Policy scope attached to a consumer credential (issue #748).
 *
 * A credential may be restricted to a set of feeds, a set of operations, a set
 * of environments, and an absolute expiry. Every dimension is optional; an
 * absent (or empty) dimension means "unrestricted" for that dimension, which is
 * also the documented migration default for keys created before scopes existed.
 *
 * - `feeds`: feed identifiers the key may read (e.g. `XLM/USD`). `*` matches all.
 * - `operations`: operation names the key may invoke (e.g. `read`, `submit`). `*` matches all.
 * - `environments`: deployment environments the key is valid in (e.g. `production`). `*` matches all.
 * - `expiresAt`: epoch milliseconds after which the key is rejected. Absent means no expiry.
 */
export interface KeyPolicyScope {
  feeds?: string[];
  operations?: string[];
  environments?: string[];
  expiresAt?: number;
}

/** Result of evaluating a credential against a requested scope. */
export interface ScopeCheckResult {
  allowed: boolean;
  /** Machine-readable reason when `allowed` is false. */
  reason?: 'expired' | 'feed' | 'operation' | 'environment';
}

/** Wildcard token that matches any value within a scope dimension. */
export const SCOPE_WILDCARD = '*';

export interface ApiKeyMetadata {
  keyHash: string;
  /** Non-secret leading segment of the key, kept for display in admin listings */
  keyPrefix: string;
  createdAt: number;
  lastUsed: number | null;
  requestCount: number;
  isActive: boolean;
  rateLimitPerMin: number;
  tier: KeyTier;
  role: Role;
  scopes?: string[];
  description?: string;
  /** If set, this key is in rotation grace period until this timestamp */
  rotationExpiresAt?: number;
  /**
   * Policy scope restricting feeds/operations/environments and expiry.
   * Absent means unrestricted (the migration default for legacy keys).
   */
  policy?: KeyPolicyScope;
}

/** Metadata plus the plaintext key, returned only when a key is created or rotated. */
export interface GeneratedApiKey extends ApiKeyMetadata {
  key: string;
}

export interface ApiKeyStoreMap {
  [keyHash: string]: ApiKeyMetadata;
}

/** Durable backing store for API keys (Vault KV at `secret/data/api/keys` in production). */
export interface KeyStore {
  load(): Promise<Record<string, ApiKeyEntry> | null>;
  save(entries: Record<string, ApiKeyEntry>): Promise<void>;
}

/** Same display prefix present in both the environment seed and the key store, with different key hashes. */
export interface KeyConflict {
  keyPrefix: string;
  envHash: string;
  storeHash: string;
}

export interface KeyStoreBootReport {
  loaded: number;
  seeded: number;
  conflicts: KeyConflict[];
}

export type KeyStoreRefreshResult = 'refreshed' | 'empty' | 'failed';

/** A mutation was rolled back because the key store write failed (or was unavailable). */
export class KeyStoreWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeyStoreWriteError';
  }
}

function canonicalKeyJson(entries: Record<string, ApiKeyEntry>): string {
  return JSON.stringify(Object.keys(entries).sort().map((hash) => [hash, entries[hash]]));
}

/** Thrown when a policy scope supplied at key generation is malformed. */
export class InvalidPolicyScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPolicyScopeError';
  }
}

function normalizeDimension(values: unknown, field: string): string[] | undefined {
  if (values === undefined || values === null) return undefined;
  if (!Array.isArray(values)) {
    throw new InvalidPolicyScopeError(`policy.${field} must be an array of strings`);
  }
  const cleaned: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidPolicyScopeError(`policy.${field} entries must be non-empty strings`);
    }
    const trimmed = value.trim();
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Validate and normalize a caller-supplied policy scope. Throws
 * InvalidPolicyScopeError on malformed input so bad scopes never reach the
 * store. Returns `undefined` when the scope is absent or fully unrestricted.
 */
export function normalizePolicyScope(policy?: KeyPolicyScope | null): KeyPolicyScope | undefined {
  if (!policy) return undefined;
  const feeds = normalizeDimension(policy.feeds, 'feeds');
  const operations = normalizeDimension(policy.operations, 'operations');
  const environments = normalizeDimension(policy.environments, 'environments');
  let expiresAt: number | undefined;
  if (policy.expiresAt !== undefined && policy.expiresAt !== null) {
    if (typeof policy.expiresAt !== 'number' || !Number.isFinite(policy.expiresAt) || policy.expiresAt <= 0) {
      throw new InvalidPolicyScopeError('policy.expiresAt must be a positive epoch-millisecond timestamp');
    }
    expiresAt = Math.floor(policy.expiresAt);
  }
  if (!feeds && !operations && !environments && expiresAt === undefined) return undefined;
  return { feeds, operations, environments, expiresAt };
}

function dimensionAllows(allowed: string[] | undefined, requested: string | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (allowed.includes(SCOPE_WILDCARD)) return true;
  if (requested === undefined) return false;
  return allowed.includes(requested);
}

/** True when the credential's policy has an expiry that has already passed. */
export function isPolicyExpired(policy: KeyPolicyScope | undefined, now: number = Date.now()): boolean {
  return !!policy && typeof policy.expiresAt === 'number' && now >= policy.expiresAt;
}

/**
 * Evaluate a credential policy against a requested feed/operation/environment.
 * An absent policy (legacy key) is unrestricted. Expiry is checked first so an
 * expired key is rejected regardless of the requested dimensions.
 */
export function checkPolicyScope(
  policy: KeyPolicyScope | undefined,
  request: { feed?: string; operation?: string; environment?: string },
  now: number = Date.now(),
): ScopeCheckResult {
  if (!policy) return { allowed: true };
  if (isPolicyExpired(policy, now)) return { allowed: false, reason: 'expired' };
  if (!dimensionAllows(policy.feeds, request.feed)) return { allowed: false, reason: 'feed' };
  if (!dimensionAllows(policy.operations, request.operation)) return { allowed: false, reason: 'operation' };
  if (!dimensionAllows(policy.environments, request.environment)) return { allowed: false, reason: 'environment' };
  return { allowed: true };
}

export class ApiKeyManager {
  /** Local mirror of the shared store, keyed by SHA-256 hash — plaintext is never retained. */
  private keys: Map<string, ApiKeyMetadata> = new Map();

  constructor(private window: TenantWindow = createTenantWindow()) {
    this.loadKeysFromEnv();
  }

  /**
   * Bootstrap from the shared store. The store is authoritative: if it already
   * holds keys they replace whatever this replica loaded from the environment,
   * and the environment is used only to seed an empty store. A failed load marks
   * the store unhealthy, which fails every subsequent validation closed.
   */
  async initialize(): Promise<void> {
    if (this.bootstrapped) return;
    try {
      const snapshot = await this.store.load();
      if (snapshot.length > 0) {
        this.keys = this.toLocalMap(snapshot);
        logger.info(`Loaded ${this.keys.size} API keys from the ${this.store.kind} store`);
      } else if (this.keys.size > 0) {
        await this.persistAll(Array.from(this.keys.values()));
        logger.info(`Seeded ${this.keys.size} API keys into the ${this.store.kind} store`);
      }
      this.storeHealthy = true;
      this.bootstrapped = true;
    } catch (err) {
      this.storeHealthy = false;
      logger.error(`API key store unavailable at bootstrap (${this.store.kind})`, err);
    }
  }

  /** Reconcile the local mirror with the store. Called on a timer and after writes. */
  async refresh(): Promise<void> {
    if (!this.bootstrapped) return;
    try {
      const snapshot = await this.store.load();
      this.keys = this.toLocalMap(snapshot);
      this.storeHealthy = true;
    } catch (err) {
      this.storeHealthy = false;
      logger.error(`API key store refresh failed (${this.store.kind})`, err);
    }
  }

  /** Start the background refresh loop that bounds cross-replica staleness. */
  startRefresh(intervalMs: number = config.apiKeyStore.refreshIntervalMs): void {
    if (this.refreshTimer) return;
    if (intervalMs <= 0) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Await every queued store write. */
  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  get isStoreHealthy(): boolean {
    return this.storeHealthy;
  }

  get storeKind(): ApiKeyStore['kind'] {
    return this.store.kind;
  }

  generateKey(
    rateLimitPerMin: number = TIER_RATE_LIMITS.free,
    description?: string,
    tier: KeyTier = 'free',
    role: Role = 'viewer',
    scopes?: string[],
    policy?: KeyPolicyScope,
  ): GeneratedApiKey {
    // Validate before minting so a malformed policy never produces a key.
    const normalizedPolicy = normalizePolicyScope(policy);
    const key = this.createKey(tier);
    const keyHash = this.hashKey(key);
    const metadata: ApiKeyMetadata = {
      keyHash,
      keyPrefix: key.substring(0, 12),
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      isActive: true,
      rateLimitPerMin: effectiveTenantLimit(tier, rateLimitPerMin),
      tier,
      role,
      scopes: scopes && scopes.length > 0 ? [...scopes] : undefined,
      description,
      policy: normalizedPolicy,
    };

    this.keys.set(keyHash, metadata);
    this.persist(metadata);
    logger.info(
      `Generated new API key: ${metadata.keyPrefix}... tier=${tier} role=${role} limit=${rateLimitPerMin}/min` +
      (normalizedPolicy ? ` policy=${describePolicy(normalizedPolicy)}` : ''),
    );

    return { ...metadata, key };
  }

  validateKey(key: string): { valid: boolean; metadata?: ApiKeyMetadata; error?: string } {
    if (!this.storeHealthy) {
      return { valid: false, error: 'API key store unavailable' };
    }

    const metadata = this.keys.get(this.hashKey(key));

    if (!metadata) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (!metadata.isActive) {
      return { valid: false, error: 'API key has been revoked' };
    }

    if (isPolicyExpired(metadata.policy)) {
      return { valid: false, error: 'API key has expired' };
    }

    return { valid: true, metadata };
  }

  /**
   * Check a validated key's policy scope against a requested feed/operation/
   * environment. Returns `{ allowed: false }` for unknown or inactive keys so
   * callers cannot bypass validation by calling this directly.
   */
  checkScope(
    key: string,
    request: { feed?: string; operation?: string; environment?: string },
    now: number = Date.now(),
  ): ScopeCheckResult {
    const metadata = this.keys.get(this.hashKey(key));
    if (!metadata || !metadata.isActive) return { allowed: false, reason: 'operation' };
    return checkPolicyScope(metadata.policy, request, now);
  }

  /** Replace a key's policy scope. `undefined` clears it (unrestricted). */
  updatePolicy(keyHash: string, policy?: KeyPolicyScope): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;
    metadata.policy = normalizePolicyScope(policy);
    this.persist(metadata);
    logger.info(
      `Updated policy for ${metadata.keyPrefix}... to ${metadata.policy ? describePolicy(metadata.policy) : 'unrestricted'}`,
    );
    return true;
  }

  isAdminKey(key: string): boolean {
    if (!this.storeHealthy) return false;
    const metadata = this.keys.get(this.hashKey(key));
    return !!metadata && metadata.role === 'admin';
  }

  /**
   * The authoritative tenant allowance: one shared fixed window per key hash
   * (Redis-backed across replicas when configured, per-pod otherwise) using
   * the effective limit from the limit model. `limit` is the number actually
   * enforced and the value reported in `X-RateLimit-Limit`.
   */
  async checkRateLimit(key: string): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
    retryAfter?: number;
    limit: number;
    degraded: boolean;
    mode: 'shared-redis' | 'local-per-pod';
  }> {
    const keyHash = this.hashKey(key);
    const metadata = this.keys.get(keyHash);
    if (!metadata) {
      return { allowed: false, remaining: 0, resetTime: 0, limit: 0, degraded: false, mode: 'local-per-pod' };
    }

    const limit = effectiveTenantLimit(metadata.tier, metadata.rateLimitPerMin);
    const result = await this.window.consume(keyHash, limit);
    const resetTime = result.reset * 1000;

    if (result.allowed) {
      metadata.lastUsed = Date.now();
      metadata.requestCount++;
    }

    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetTime,
      retryAfter: result.allowed ? undefined : Math.max(1, result.reset - Math.floor(Date.now() / 1000)),
      limit: result.limit,
      degraded: !result.shared,
      mode: result.mode,
    };
  }

  rotateKey(oldKeyHash: string): GeneratedApiKey | null {
    const metadata = this.keys.get(oldKeyHash);
    if (!metadata) return null;

    const newKey = this.createKey(metadata.tier);
    const newHash = this.hashKey(newKey);
    const newMetadata: ApiKeyMetadata = {
      ...metadata,
      keyHash: newHash,
      keyPrefix: newKey.substring(0, 12),
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      scopes: metadata.scopes ? [...metadata.scopes] : undefined,
    };

    this.keys.delete(oldKeyHash);
    this.keys.set(newHash, newMetadata);
    this.enqueue(async () => {
      await this.store.remove(oldKeyHash);
      await this.store.put(newMetadata);
    });
    logger.info(`Rotated API key: old=${metadata.keyPrefix}... new=${newMetadata.keyPrefix}...`);

    return { ...newMetadata, key: newKey };
  }

  revokeKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.isActive = false;
    this.persist(metadata);
    logger.info(`Revoked API key: ${metadata.keyPrefix}...`);
    return true;
  }

  deactivateKey(keyHash: string): boolean {
    return this.revokeKey(keyHash);
  }

  reactivateKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.isActive = true;
    this.persist(metadata);
    logger.info(`Reactivated API key: ${metadata.keyPrefix}...`);
    return true;
  }

  getKeyMetadata(keyHash: string): ApiKeyMetadata | null {
    return this.keys.get(keyHash) || null;
  }

  getAllKeys(): Array<{ keyPrefix: string; keyHash: string; createdAt: number; lastUsed: number | null; requestCount: number; isActive: boolean; rateLimitPerMin: number; tier: KeyTier; role: Role; scopes?: string[]; description?: string; policy?: KeyPolicyScope }> {
    // The non-secret display prefix is returned as-is (no ellipsis suffix) so
    // consumers can match keys by prefix without string munging.
    return Array.from(this.keys.values()).map((m) => ({
      keyPrefix: m.keyPrefix,
      keyHash: m.keyHash,
      createdAt: m.createdAt,
      lastUsed: m.lastUsed,
      requestCount: m.requestCount,
      isActive: m.isActive,
      rateLimitPerMin: m.rateLimitPerMin,
      tier: m.tier,
      role: m.role,
      scopes: m.scopes,
      description: m.description,
      policy: m.policy ? { ...m.policy } : undefined,
    }));
  }

  findByHash(hash: string): ApiKeyMetadata | null {
    return this.keys.get(hash) || null;
  }

  updateRateLimit(keyHash: string, newLimit: number): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    const effective = effectiveTenantLimit(metadata.tier, newLimit);
    metadata.rateLimitPerMin = effective;
    logger.info(
      `Updated rate limit for ${metadata.keyPrefix}... to ${effective}/min (tier=${metadata.tier}, ceiling applies)`,
    );
    return true;
  }

  updateTier(keyHash: string, tier: KeyTier): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.tier = tier;
    metadata.rateLimitPerMin = TIER_RATE_LIMITS[tier];
    this.persist(metadata);
    logger.info(`Updated tier for ${metadata.keyPrefix}... to ${tier} (${TIER_RATE_LIMITS[tier]}/min)`);
    return true;
  }

  deleteKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    const result = this.keys.delete(keyHash);
    if (result) {
      logger.info(`Deleted API key: ${metadata!.keyPrefix}...`);
    }
    return result;
  }

  setStore(store: KeyStore | null): void {
    this.store = store;
  }

  hasStore(): boolean {
    return this.store !== null;
  }

  /** Deep copy of the in-memory key map, used to roll back failed transactions. */
  snapshot(): Record<string, ApiKeyMetadata> {
    return structuredClone(Object.fromEntries(this.keys));
  }

  restore(snapshot: Record<string, ApiKeyMetadata>): void {
    this.keys = new Map(Object.entries(snapshot));
  }

  /** Write memory to the store. No-op without a store; throws when the store rejects the write. */
  async syncToStore(): Promise<void> {
    if (!this.store) return;
    const entries = this.exportKeysForVault();
    const serialized = canonicalKeyJson(entries);
    if (serialized === this.lastSyncedJson) return;
    await this.store.save(entries);
    this.lastSyncedJson = serialized;
  }

  /**
   * Boot sequence: load the store, report environment-seed conflicts, merge,
   * drop runtime-only keys once the store is authoritative, and seed anything
   * the store is missing. Throws when the store cannot be read.
   */
  async hydrate(): Promise<KeyStoreBootReport> {
    if (!this.store) return { loaded: 0, seeded: 0, conflicts: [] };
    const storeKeys = (await this.store.load()) ?? {};
    const loaded = Object.keys(storeKeys).length;
    let conflicts: KeyConflict[] = [];
    if (loaded > 0) {
      conflicts = this.compareWithStore(storeKeys);
      for (const conflict of conflicts) {
        logger.warn(
          `API key store conflict for prefix ${conflict.keyPrefix}: environment seed ${conflict.envHash.substring(0, 12)} vs store ${conflict.storeHash.substring(0, 12)} — both retained, not silently preferring one`,
        );
      }
      this.loadKeysFromVault(storeKeys);
      for (const hash of [...this.keys.keys()]) {
        if (!storeKeys[hash] && !this.envKeyHashes.has(hash)) {
          const orphan = this.keys.get(hash)!;
          this.keys.delete(hash);
          logger.warn(
            `Dropped runtime-generated API key ${orphan.keyPrefix}... — it is not in the key store; seed keys via API_KEYS or create them through the admin API so they persist`,
          );
        }
      }
    }
    const missing =
      loaded > 0
        ? [...this.envKeyHashes].filter((hash) => !storeKeys[hash])
        : [...this.keys.keys()];
    if (missing.length > 0) {
      await this.syncToStore();
      logger.info(`Seeded ${missing.length} API key(s) into the key store`);
    }
    return { loaded, seeded: missing.length, conflicts };
  }

  /** Compare environment-seeded keys against the store: same prefix with a different hash is a conflict. */
  compareWithStore(storeKeys: Record<string, ApiKeyEntry>): KeyConflict[] {
    const conflicts: KeyConflict[] = [];
    for (const [hash, entry] of Object.entries(storeKeys)) {
      if (!entry || typeof entry.keyHash !== 'string' || this.envKeyHashes.has(hash)) continue;
      const envPeer = Array.from(this.envKeyHashes)
        .map((envHash) => this.keys.get(envHash))
        .find((meta) => meta !== undefined && meta.keyPrefix === entry.keyPrefix);
      if (envPeer && envPeer.keyHash !== entry.keyHash) {
        conflicts.push({ keyPrefix: entry.keyPrefix, envHash: envPeer.keyHash, storeHash: entry.keyHash });
      }
    }
    return conflicts;
  }

  /**
   * Replace in-memory state with the store's contents (replica refresh).
   * Never wipes memory on an empty store; in-flight usage counters survive.
   */
  async refreshFromStore(): Promise<KeyStoreRefreshResult> {
    if (!this.store) return 'empty';
    let storeKeys: Record<string, ApiKeyEntry> | null;
    try {
      storeKeys = await this.store.load();
    } catch (err) {
      logger.warn('API key store refresh failed; keeping in-memory keys', err);
      return 'failed';
    }
    if (!storeKeys || Object.keys(storeKeys).length === 0) return 'empty';
    const previous = this.keys;
    const next = new Map<string, ApiKeyMetadata>();
    for (const entry of Object.values(storeKeys)) {
      if (!entry || typeof entry.keyHash !== 'string' || entry.keyHash.length === 0) continue;
      const metadata = this.metadataFromEntry(entry);
      const prior = previous.get(entry.keyHash);
      if (prior) {
        metadata.lastUsed = prior.lastUsed;
        metadata.requestCount = prior.requestCount;
      }
      next.set(entry.keyHash, metadata);
    }
    if (next.size === 0) return 'empty';
    this.keys = next;
    this.lastSyncedJson = canonicalKeyJson(this.exportKeysForVault());
    return 'refreshed';
  }

  /**
   * Run a mutation against the authoritative store: refresh first, mutate,
   * then persist before returning. A failed refresh aborts the mutation; a
   * failed write rolls the mutation back and throws KeyStoreWriteError.
   */
  async transact<T>(mutate: () => T): Promise<T> {
    if (this.store) {
      const refreshed = await this.refreshFromStore();
      if (refreshed === 'failed') {
        throw new KeyStoreWriteError('API key store unavailable; mutation was not applied');
      }
    }
    const before = this.snapshot();
    const result = mutate();
    try {
      await this.syncToStore();
    } catch (err) {
      this.restore(before);
      throw new KeyStoreWriteError(
        `API key store write failed; mutation rolled back: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    return result;
  }

  /** Export all keys in Vault-compatible format for persistence.
   *  Contract: only the SHA-256 hash of the key material and its metadata are
   *  stored — the plaintext key is never written (`key` is blank). On restore,
   *  validation works by hashing the presented key and matching it against
   *  `keyHash`; the plaintext itself cannot be reconstructed from the store. */
  exportKeysForVault(): Record<string, ApiKeyEntry> {
    const result: Record<string, ApiKeyEntry> = {};
    for (const [hash, meta] of this.keys) {
      result[hash] = {
        keyHash: meta.keyHash,
        keyPrefix: meta.keyPrefix,
        key: '',
        tier: meta.tier,
        role: meta.role,
        scopes: meta.scopes,
        rateLimitPerMin: meta.rateLimitPerMin,
        description: meta.description,
        createdAt: meta.createdAt,
        isActive: meta.isActive,
        policy: meta.policy ? { ...meta.policy } : undefined,
      };
    }
    return result;
  }

  /** Load keys from Vault into the in-memory store. Returns how many entries were accepted. */
  loadKeysFromVault(vaultKeys: Record<string, ApiKeyEntry>): number {
    let loaded = 0;
    for (const entry of Object.values(vaultKeys)) {
      if (!entry || typeof entry.keyHash !== 'string' || entry.keyHash.length === 0) {
        logger.warn('Skipping malformed API key entry in store (missing keyHash)');
        continue;
      }
      this.keys.set(entry.keyHash, this.metadataFromEntry(entry));
      loaded += 1;
    }
    logger.info(`Loaded ${loaded} API keys from Vault`);
    return loaded;
  }

  private metadataFromEntry(entry: ApiKeyEntry): ApiKeyMetadata {
    const keyPrefix =
      entry.keyPrefix ||
      (entry.key && entry.key.length >= 12 ? entry.key.substring(0, 12) : entry.keyHash.substring(0, 12));
    return {
      keyHash: entry.keyHash,
      keyPrefix,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      lastUsed: null,
      requestCount: 0,
      isActive: entry.isActive !== false,
      rateLimitPerMin: typeof entry.rateLimitPerMin === 'number' ? entry.rateLimitPerMin : TIER_RATE_LIMITS.free,
      tier: (entry.tier as KeyTier) || 'free',
      role: (entry.role as Role) || 'viewer',
      scopes: Array.isArray(entry.scopes) ? [...entry.scopes] : undefined,
      description: entry.description,
      // Legacy entries have no policy: they load as unrestricted, which is the
      // documented migration default. Malformed stored policies are dropped
      // (fail-open to unrestricted) rather than blocking the whole load.
      policy: this.policyFromEntry(entry),
    };
  }

  private policyFromEntry(entry: ApiKeyEntry): KeyPolicyScope | undefined {
    const raw = (entry as ApiKeyEntry & { policy?: unknown }).policy;
    if (!raw || typeof raw !== 'object') return undefined;
    try {
      return normalizePolicyScope(raw as KeyPolicyScope);
    } catch (err) {
      logger.warn(
        `Ignoring malformed policy on stored API key ${entry.keyHash.substring(0, 12)}...: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private createKey(tier: KeyTier = 'free'): string {
    const prefix = tier === 'admin' ? adminKeyPrefix() : `sk_${tier}_`;
    return prefix + crypto.randomBytes(32).toString('hex');
  }

  private toLocalMap(snapshot: ApiKeyMetadata[]): Map<string, ApiKeyMetadata> {
    const next = new Map<string, ApiKeyMetadata>();
    for (const entry of snapshot) {
      const local = this.keys.get(entry.keyHash);
      // lastUsed/requestCount are per-replica activity counters, not shared
      // state: the locally observed value is the more accurate one.
      const counters = local
        ? { lastUsed: local.lastUsed, requestCount: local.requestCount }
        : { lastUsed: entry.lastUsed, requestCount: entry.requestCount };
      next.set(entry.keyHash, { ...entry, ...counters });
    }
    return next;
  }

  private persist(entry: ApiKeyMetadata): void {
    this.enqueue(() => this.store.put(entry));
  }

  private persistAll(entries: ApiKeyMetadata[]): void {
    if (entries.length === 0) return;
    this.enqueue(async () => {
      for (const entry of entries) {
        await this.store.put(entry);
      }
    });
  }

  private enqueue(write: () => Promise<void>): void {
    this.pendingWrites = this.pendingWrites.then(write).catch((err) => {
      this.storeHealthy = false;
      logger.error(`API key store write failed (${this.store.kind})`, err);
    });
  }

  private loadKeysFromEnv(): void {
    const envKeys = process.env.API_KEYS ? decryptSecret(process.env.API_KEYS) : undefined;
    if (!envKeys || !envKeys.trim()) {
      if (this.keys.size === 0 && process.env.ALLOW_EPHEMERAL_ADMIN_KEY === 'true') {
        this.generateEphemeralAdminKey();
      } else if (this.keys.size === 0) {
        logger.warn(
          'API_KEYS is not configured and ALLOW_EPHEMERAL_ADMIN_KEY is not set; ' +
          'the key store is empty. See docs/KEY_MANAGEMENT.md#api-key-bootstrap.',
        );
      }
      return;
    }

    try {
      // Format: key1:limit1:desc1:tier1:role1,key2:...
      for (const spec of envKeys.split(',')) {
        const parts = spec.trim().split(':');
        if (parts.length >= 1 && parts[0]) {
          const key = parts[0];
          const limit = parseInt(parts[1], 10);
          const description = parts[2] || undefined;
          const tier = (parts[3] as KeyTier) || 'free';
          const role = (parts[4] as Role) || 'viewer';

          const keyHash = this.hashKey(key);
          const metadata: ApiKeyMetadata = {
            keyHash,
            keyPrefix: key.substring(0, 12),
            createdAt: Date.now(),
            lastUsed: null,
            requestCount: 0,
            isActive: true,
            rateLimitPerMin: effectiveTenantLimit(tier, isNaN(limit) ? undefined : limit),
            tier,
            role,
            description,
          };

          this.keys.set(keyHash, metadata);
          this.envKeyHashes.add(keyHash);
        }
      }

      this.envKeyCount = this.keys.size;
      logger.info(`Loaded ${this.envKeyCount} API keys from environment`);
    } catch (err) {
      logger.error('Failed to load API keys from environment', err);
    }
  }

  /** Generate a single ephemeral admin key for local/dev bootstrapping. */
  private generateEphemeralAdminKey(): void {
    const key = 'ephemeral-admin-' + crypto.randomBytes(16).toString('hex');
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    this.keys.set(keyHash, {
      keyHash,
      tier: 'admin',
      createdAt: Date.now(),
      description: 'ephemeral admin key',
    });
  }
}

function describePolicy(policy: KeyPolicyScope): string {
  const parts: string[] = [];
  if (policy.feeds) parts.push(`feeds=${policy.feeds.join('|')}`);
  if (policy.operations) parts.push(`operations=${policy.operations.join('|')}`);
  if (policy.environments) parts.push(`environments=${policy.environments.join('|')}`);
  if (policy.expiresAt !== undefined) parts.push(`expiresAt=${new Date(policy.expiresAt).toISOString()}`);
  return parts.join(',');
}

export const apiKeyManager = new ApiKeyManager();

/**
 * Startup key-source check (issue #592). Reports how many keys were loaded
 * from where and refuses to start in production when no key source exists.
 * Call after the Vault load so store-backed keys are counted.
 */
export function bootstrapApiKeyStore(manager: ApiKeyManager = apiKeyManager): KeyBootstrapReport {
  const report = manager.getBootstrapReport();

  if (report.count === 0) {
    if (isProduction()) {
      throw new MissingKeySourceError(
        'No API key source configured: API_KEYS is unset or empty and the Vault key store did not ' +
        'supply any keys. Refusing to start in production. Set API_KEYS (format ' +
        '`key:rateLimit:description:tier:role`, see .env.example) or seed the Vault store. For local ' +
        'development and tests only, set ALLOW_EPHEMERAL_ADMIN_KEY=true. ' +
        'See docs/KEY_MANAGEMENT.md#api-key-bootstrap.',
      );
    }
    logger.warn(
      'API key bootstrap: source=none count=0 health=empty. No admin key exists; every admin route ' +
      'will reject requests. See docs/KEY_MANAGEMENT.md#api-key-bootstrap.',
    );
    return report;
  }

  logger.info(
    `API key bootstrap: source=${report.source} count=${report.count} health=${report.health}` +
    (report.ephemeral ? ' (ephemeral key present, not durable)' : ''),
  );
  return report;
}
