/**
 * HashiCorp Vault client for the Stellar Oracle.
 *
 * Provides secrets management for:
 *   - API keys (stored at secret/data/api/keys)
 *   - Webhook secrets (stored at secret/data/webhooks)
 *   - Contract admin keys (stored at secret/data/contract/admin)
 *   - Database credentials (stored at secret/data/database/config)
 *
 * Uses Vault's KV v2 secrets engine with token-based authentication.
 */

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_VAULT_URL = 'http://127.0.0.1:8200';
const DEFAULT_VAULT_TOKEN = 'dev-root-super-secret-token';
const DEFAULT_AUDIT_LOG_PATH = './logs/vault_audit.log';

export interface VaultConfig {
  url?: string;
  token?: string;
  auditLogPath?: string;
  /** Number of retries for transient Vault errors */
  maxRetries?: number;
  /** Base backoff in ms for retry attempts */
  retryBaseMs?: number;
}

// ── Secret value types ───────────────────────────────────────────────────────

export interface ApiKeyEntry {
  keyHash: string;
  keyPrefix: string;
  key: string;
  tier: string;
  role: string;
  scopes?: string[];
  rateLimitPerMin: number;
  description?: string;
  createdAt: number;
  isActive: boolean;
}

export interface WebhookSecretEntry {
  webhookId: string;
  secret: string;
  verificationKey?: string;
  apiKeyPrefix: string;
  createdAt: number;
}

export interface ContractAdminEntry {
  secretKey: string;
  contractId: string;
  networkPassphrase: string;
  label?: string;
  rotatedAt?: number;
}

// ── Result envelope ──────────────────────────────────────────────────────────

export interface VaultHealthStatus {
  initialized: boolean;
  sealed: boolean;
  reachable: boolean;
  version?: string;
}

// ── Client implementation ────────────────────────────────────────────────────

export class VaultClient {
  private vaultUrl: string;
  private vaultToken: string;
  private auditLogPath: string;
  private maxRetries: number;
  private retryBaseMs: number;
  private initialized = false;

  constructor(config: VaultConfig = {}) {
    this.vaultUrl = config.url ?? process.env.VAULT_ADDR ?? DEFAULT_VAULT_URL;
    this.vaultToken = config.token ?? process.env.VAULT_TOKEN ?? DEFAULT_VAULT_TOKEN;
    this.auditLogPath = config.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs ?? 200;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Initialize the Vault connection: ensure the KV v2 secrets engine is
   * mounted and the Vault instance is reachable and unsealed.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const health = await this.checkHealth();
    if (!health.reachable) {
      throw new Error(`Vault not reachable at ${this.vaultUrl}`);
    }
    if (health.sealed) {
      throw new Error('Vault is sealed — unseal it before starting the service');
    }

    await this.bootstrapKvEngine();
    this.initialized = true;
    this.logAudit('VAULT_INIT', 'sys/init');
  }

  /** Check whether the client has been initialized. */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async checkHealth(): Promise<VaultHealthStatus> {
    try {
      const resp = await axios.get(`${this.vaultUrl}/v1/sys/health`, {
        headers: { 'X-Vault-Token': this.vaultToken },
        timeout: 5000,
      });
      return {
        initialized: resp.data.initialized,
        sealed: resp.data.sealed,
        reachable: true,
        version: resp.data.version,
      };
    } catch {
      return { initialized: false, sealed: true, reachable: false };
    }
  }

  // ── Low-level KV v2 operations ─────────────────────────────────────────────

  /**
   * Read a secret from a KV v2 path. The path is relative to the mount
   * (e.g. `secret/data/api/keys`). Returns `null` if not found.
   */
  async readSecret<T = Record<string, unknown>>(path: string): Promise<T | null> {
    this.logAudit('READ', path);
    try {
      const resp = await this.requestWithRetry(() =>
        axios.get(`${this.vaultUrl}/v1/${path}`, {
          headers: { 'X-Vault-Token': this.vaultToken },
          timeout: 10000,
        }),
      );
      return resp.data.data.data as T;
    } catch (err: unknown) {
      if (err instanceof AxiosError && err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Write a secret to a KV v2 path. Creates the path if it doesn't exist.
   */
  async writeSecret(path: string, data: Record<string, unknown>): Promise<void> {
    this.logAudit('WRITE', path);
    await this.requestWithRetry(() =>
      axios.post(
        `${this.vaultUrl}/v1/${path}`,
        { data },
        { headers: { 'X-Vault-Token': this.vaultToken }, timeout: 10000 },
      ),
    );
  }

  /**
   * Delete a secret at a KV v2 path (soft-delete in v2 — creates a new
   * version with deletion marker).
   */
  async deleteSecret(path: string): Promise<void> {
    this.logAudit('DELETE', path);
    await this.requestWithRetry(() =>
      axios.delete(`${this.vaultUrl}/v1/${path}`, {
        headers: { 'X-Vault-Token': this.vaultToken },
        timeout: 10000,
      }),
    );
  }

  /**
   * List keys directly under a KV v2 path.
   */
  async listSecrets(path: string): Promise<string[]> {
    this.logAudit('LIST', path);
    try {
      const resp = await this.requestWithRetry(() =>
        axios.get(`${this.vaultUrl}/v1/${path}`, {
          headers: { 'X-Vault-Token': this.vaultToken },
          timeout: 10000,
          params: { list: 'true' },
        }),
      );
      return resp.data.data?.keys ?? [];
    } catch (err: unknown) {
      if (err instanceof AxiosError && err.response?.status === 404) return [];
      throw err;
    }
  }

  // ── API key management ─────────────────────────────────────────────────────

  /**
   * Load all API keys from Vault.
   * Keys are stored at `secret/data/api/keys` as a map of keyHash → ApiKeyEntry.
   */
  async loadApiKeys(): Promise<Record<string, ApiKeyEntry> | null> {
    return this.readSecret<Record<string, ApiKeyEntry>>('secret/data/api/keys');
  }

  /**
   * Persist all API keys to Vault.
   */
  async saveApiKeys(keys: Record<string, ApiKeyEntry>): Promise<void> {
    await this.writeSecret('secret/data/api/keys', keys as unknown as Record<string, unknown>);
  }

  // ── Webhook secret management ──────────────────────────────────────────────

  /**
   * Load webhook secrets for a given API key prefix.
   * Stored at `secret/data/webhooks/<apiKeyPrefix>`.
   */
  async loadWebhookSecrets(apiKeyPrefix: string): Promise<Record<string, WebhookSecretEntry> | null> {
    return this.readSecret<Record<string, WebhookSecretEntry>>(
      `secret/data/webhooks/${apiKeyPrefix}`,
    );
  }

  /**
   * Store a webhook secret entry.
   */
  async saveWebhookSecret(apiKeyPrefix: string, entry: WebhookSecretEntry): Promise<void> {
    const existing = (await this.loadWebhookSecrets(apiKeyPrefix)) ?? {};
    existing[entry.webhookId] = entry;
    await this.writeSecret(
      `secret/data/webhooks/${apiKeyPrefix}`,
      existing as unknown as Record<string, unknown>,
    );
  }

  /**
   * Remove a webhook secret.
   */
  async deleteWebhookSecret(apiKeyPrefix: string, webhookId: string): Promise<void> {
    const existing = (await this.loadWebhookSecrets(apiKeyPrefix)) ?? {};
    delete existing[webhookId];
    if (Object.keys(existing).length === 0) {
      await this.deleteSecret(`secret/data/webhooks/${apiKeyPrefix}`);
    } else {
      await this.writeSecret(
        `secret/data/webhooks/${apiKeyPrefix}`,
        existing as unknown as Record<string, unknown>,
      );
    }
  }

  // ── Contract admin key management ──────────────────────────────────────────

  /**
   * Load the active contract admin key entry.
   * Stored at `secret/data/contract/admin`.
   */
  async loadContractAdmin(): Promise<ContractAdminEntry | null> {
    return this.readSecret<ContractAdminEntry>('secret/data/contract/admin');
  }

  /**
   * Store a contract admin key entry.
   */
  async saveContractAdmin(entry: ContractAdminEntry): Promise<void> {
    await this.writeSecret('secret/data/contract/admin', entry as unknown as Record<string, unknown>);
  }

  /**
   * Rotate the contract admin key: save the old one with a rotatedAt
   * timestamp and store the new one.
   */
  async rotateContractAdmin(newEntry: ContractAdminEntry): Promise<void> {
    const current = await this.loadContractAdmin();
    if (current) {
      current.rotatedAt = Date.now();
      await this.writeSecret(
        'secret/data/contract/admin/previous',
        current as unknown as Record<string, unknown>,
      );
    }
    await this.saveContractAdmin(newEntry);
  }

  // ── Bulk initialization / seeding ──────────────────────────────────────────

  /**
   * Seed initial secrets into Vault if they don't already exist.
   * Safe to call on every startup — only writes when paths are empty.
   */
  async seedDefaults(defaults: {
    apiKeys?: Record<string, ApiKeyEntry>;
    contractAdmin?: ContractAdminEntry;
  }): Promise<void> {
    if (defaults.apiKeys) {
      const existing = await this.loadApiKeys();
      if (!existing || Object.keys(existing).length === 0) {
        await this.saveApiKeys(defaults.apiKeys);
        this.logAudit('SEED', 'secret/data/api/keys');
      }
    }

    if (defaults.contractAdmin) {
      const existing = await this.loadContractAdmin();
      if (!existing) {
        await this.saveContractAdmin(defaults.contractAdmin);
        this.logAudit('SEED', 'secret/data/contract/admin');
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async bootstrapKvEngine(): Promise<void> {
    try {
      await axios.post(
        `${this.vaultUrl}/v1/sys/mounts/secret`,
        { type: 'kv', options: { version: '2' } },
        { headers: { 'X-Vault-Token': this.vaultToken }, timeout: 10000 },
      );
      this.logAudit('MOUNT_KV', 'sys/mounts/secret');
    } catch (err: unknown) {
      // Mount may already exist — only log if the error is not "path already in use"
      if (err instanceof AxiosError && err.response?.status !== 400) {
        throw err;
      }
    }
  }

  private async requestWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        lastErr = err;
        // Only retry on server/network errors (5xx, ECONNREFUSED, etc.)
        const status = err instanceof AxiosError ? err.response?.status : undefined;
        if (status && status < 500 && status !== 429) throw err;
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBaseMs * 2 ** attempt);
        }
      }
    }
    throw lastErr;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logAudit(action: string, targetPath: string): void {
    const logEntry = `[${new Date().toISOString()}] AUDIT: Action=${action} Target=${targetPath} Actor=OracleBackend\n`;
    try {
      const dir = path.dirname(this.auditLogPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.auditLogPath, logEntry);
    } catch {
      // Audit logging is best-effort; never crash on log write failure
    }
  }
}

// ── Singleton convenience ─────────────────────────────────────────────────────

let defaultClient: VaultClient | null = null;

export function getVaultClient(config?: VaultConfig): VaultClient {
  if (!defaultClient) {
    defaultClient = new VaultClient(config);
  }
  return defaultClient;
}

export function resetVaultClient(): void {
  defaultClient = null;
}
