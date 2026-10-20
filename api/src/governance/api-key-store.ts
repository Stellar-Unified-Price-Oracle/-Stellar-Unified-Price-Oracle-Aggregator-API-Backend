import Redis from 'ioredis';
import type { ApiKeyMetadata } from './api-key-manager';

/** Minimum surface a key store must provide for the manager to read/write. */
export interface ApiKeyStore {
  readonly kind: 'memory' | 'redis';
  load(): Promise<ApiKeyMetadata[]>;
  put(entry: ApiKeyMetadata): Promise<void>;
  remove(keyHash: string): Promise<void>;
}

/** A single Redis hash holds every key: field = keyHash, value = JSON metadata. */
export interface RedisLikeClient {
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
}

/**
 * Migration default for records written before policy scopes existed (#748).
 *
 * Legacy keys were issued without any scope restriction, so they are treated as
 * unrestricted (`feeds`/`operations`/`environments` undefined) and non-expiring
 * (`expiresAt` undefined). This preserves the behaviour of existing consumers
 * while new keys can opt into narrower scopes. Rollback: removing the scope
 * fields from persisted records restores the legacy shape; the store tolerates
 * both shapes in either direction.
 */
export function applyScopeDefaults(entry: ApiKeyMetadata): ApiKeyMetadata {
  const normalized: ApiKeyMetadata = { ...entry };
  if (normalized.feeds !== undefined && !Array.isArray(normalized.feeds)) delete normalized.feeds;
  if (normalized.operations !== undefined && !Array.isArray(normalized.operations)) delete normalized.operations;
  if (normalized.environments !== undefined && !Array.isArray(normalized.environments)) delete normalized.environments;
  if (normalized.expiresAt !== undefined && typeof normalized.expiresAt !== 'string') delete normalized.expiresAt;
  return normalized;
}

function parseEntry(raw: string): ApiKeyMetadata | null {
  try {
    const parsed = JSON.parse(raw) as ApiKeyMetadata;
    if (!parsed || typeof parsed.keyHash !== 'string' || typeof parsed.isActive !== 'boolean') return null;
    return applyScopeDefaults(parsed);
  } catch {
    return null;
  }
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, ApiKeyMetadata>();

  async load(): Promise<ApiKeyMetadata[]> {
    return Array.from(this.entries.values()).map((entry) => applyScopeDefaults({ ...entry }));
  }

  async put(entry: ApiKeyMetadata): Promise<void> {
    this.entries.set(entry.keyHash, applyScopeDefaults({ ...entry }));
  }

  async remove(keyHash: string): Promise<void> {
    this.entries.delete(keyHash);
  }

  get size(): number {
    return this.entries.size;
  }
}

export class RedisApiKeyStore implements ApiKeyStore {
  readonly kind = 'redis' as const;
  private readonly hashKey: string;
  private client: RedisLikeClient | null = null;
  private readonly ownClient: Redis | null = null;

  constructor(client: RedisLikeClient, hashKey?: string);
  constructor(url: string, hashKey?: string);
  constructor(clientOrUrl: RedisLikeClient | string, hashKey = 'oracle:api-keys') {
    this.hashKey = hashKey;
    if (typeof clientOrUrl === 'string') {
      this.ownClient = new Redis(clientOrUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      this.client = this.ownClient;
    } else {
      this.client = clientOrUrl;
    }
  }

  private async conn(): Promise<RedisLikeClient> {
    if (!this.client) throw new Error('redis client not configured');
    const client = this.client as RedisLikeClient & { status?: string; connect?(): Promise<void> };
    if (this.ownClient && client.status === 'end') {
      await client.connect!();
    }
    return client;
  }

  async load(): Promise<ApiKeyMetadata[]> {
    const client = await this.conn();
    const raw = await client.hgetall(this.hashKey);
    const entries: ApiKeyMetadata[] = [];
    for (const value of Object.values(raw || {})) {
      const entry = parseEntry(value);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async put(entry: ApiKeyMetadata): Promise<void> {
    const client = await this.conn();
    await client.hset(this.hashKey, entry.keyHash, JSON.stringify(applyScopeDefaults(entry)));
  }

  async remove(keyHash: string): Promise<void> {
    const client = await this.conn();
    await client.hdel(this.hashKey, keyHash);
  }

  async close(): Promise<void> {
    if (this.ownClient) await this.ownClient.quit().catch(() => undefined);
  }
}
