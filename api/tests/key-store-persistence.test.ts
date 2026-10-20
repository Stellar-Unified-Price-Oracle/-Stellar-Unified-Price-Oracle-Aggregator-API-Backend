import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ApiKeyManager,
  KeyStoreWriteError,
  apiKeyManager,
  TIER_RATE_LIMITS,
  type KeyStore,
} from '../src/governance/api-key-manager';
import type { ApiKeyMetadata } from '../src/governance/api-key-manager';
import type { ApiKeyEntry } from '@stellar-oracle/vault-client';
import adminRouter from '../src/governance/admin';

function fileKeyStore(storePath: string): KeyStore {
  return {
    async load() {
      if (!fs.existsSync(storePath)) return null;
      return JSON.parse(fs.readFileSync(storePath, 'utf8')) as Record<string, ApiKeyEntry>;
    },
    async save(entries) {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
      fs.renameSync(tmp, storePath);
    },
  };
}

function recordingStore(options: { loadResult?: Record<string, ApiKeyEntry> | null; failSave?: boolean } = {}) {
  const saved: Array<Record<string, ApiKeyEntry>> = [];
  const store: KeyStore = {
    async load() {
      return options.loadResult ?? null;
    },
    async save(entries) {
      if (options.failSave) throw new Error('vault sealed');
      saved.push(entries);
    },
  };
  return { store, saved };
}

describe('Issue #609: API key store persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.stubEnv('API_KEYS', '');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-store-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('export/import contract', () => {
    it('round-trips a key that validates after restore, without storing plaintext', async () => {
      const original = new ApiKeyManager();
      const generated = original.generateKey(500, 'round trip', 'pro', 'editor', ['prices:read']);

      const exported = original.exportKeysForVault();
      expect(exported[generated.keyHash].key).toBe('');
      expect(exported[generated.keyHash].keyHash).toBe(generated.keyHash);
      expect(exported[generated.keyHash].keyPrefix).toBe(generated.keyPrefix);

      const restored = new ApiKeyManager();
      const loaded = restored.loadKeysFromVault(exported);
      expect(loaded).toBe(Object.keys(exported).length);

      const validation = restored.validateKey(generated.key);
      expect(validation.valid).toBe(true);
      expect(validation.metadata!.role).toBe('editor');
      expect(validation.metadata!.tier).toBe('pro');
      expect(validation.metadata!.scopes).toEqual(['prices:read']);
      expect(validation.metadata!.rateLimitPerMin).toBe(500);
      expect(validation.metadata!.description).toBe('round trip');
      expect(validation.metadata!.keyPrefix).toBe(generated.keyPrefix);
      expect(validation.metadata!.isActive).toBe(true);

      expect(restored.validateKey('sk_pro_definitely-not-a-real-key').valid).toBe(false);
    });

    it('imports entries with a blank key and missing keyPrefix by falling back to the hash', () => {
      const mgr = new ApiKeyManager();
      const hash = 'a'.repeat(64);
      const loaded = mgr.loadKeysFromVault({
        [hash]: {
          keyHash: hash,
          key: '',
          tier: 'pro',
          role: 'viewer',
          rateLimitPerMin: 100,
          createdAt: 1,
          isActive: true,
        },
      });

      expect(loaded).toBe(1);
      const meta = mgr.getKeyMetadata(hash);
      expect(meta!.keyPrefix).toBe(hash.substring(0, 12));
      expect(meta!.isActive).toBe(true);
    });

    it('skips malformed store entries instead of crashing the import', () => {
      const mgr = new ApiKeyManager();
      const goodHash = 'b'.repeat(64);
      const loaded = mgr.loadKeysFromVault({
        good: { key: '' } as unknown as ApiKeyEntry,
        [goodHash]: {
          keyHash: goodHash,
          keyPrefix: 'sk_pro_good',
          key: '',
          tier: 'pro',
          role: 'viewer',
          rateLimitPerMin: 100,
          createdAt: 1,
          isActive: true,
        },
      });

      expect(loaded).toBe(1);
      expect(mgr.getKeyMetadata(goodHash)).not.toBeNull();
    });
  });

  describe('durability across restarts', () => {
    it('persists a mutation before transact resolves and survives a fresh process', async () => {
      const storePath = path.join(tmpDir, 'keys.json');
      const mgr = new ApiKeyManager();
      mgr.setStore(fileKeyStore(storePath));

      const created = await mgr.transact(() => mgr.generateKey(123, 'persisted', 'pro', 'operator'));

      const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Record<string, ApiKeyEntry>;
      expect(onDisk[created.keyHash]).toBeDefined();
      expect(onDisk[created.keyHash].key).toBe('');

      const restarted = new ApiKeyManager();
      restarted.setStore(fileKeyStore(storePath));
      const boot = await restarted.hydrate();
      expect(boot.loaded).toBeGreaterThanOrEqual(1);
      expect(restarted.validateKey(created.key).valid).toBe(true);
      expect(restarted.getKeyMetadata(created.keyHash)!.rateLimitPerMin).toBe(123);
    });

    it('rotation survives restart: old key rejected, new key accepted (rotation drill)', async () => {
      const storePath = path.join(tmpDir, 'keys.json');
      const mgr = new ApiKeyManager();
      mgr.setStore(fileKeyStore(storePath));

      const original = await mgr.transact(() => mgr.generateKey(60, 'to rotate', 'free', 'viewer'));
      const rotated = await mgr.transact(() => mgr.rotateKey(original.keyHash));
      expect(rotated).not.toBeNull();
      expect(rotated!.key).not.toBe(original.key);

      const restarted = new ApiKeyManager();
      restarted.setStore(fileKeyStore(storePath));
      await restarted.hydrate();

      expect(restarted.validateKey(original.key).valid).toBe(false);
      expect(restarted.validateKey(original.key).error).toBe('Invalid API key');
      expect(restarted.validateKey(rotated!.key).valid).toBe(true);
      expect(restarted.getKeyMetadata(rotated!.keyHash)!.keyPrefix).toBe(rotated!.keyPrefix);
    });

    it('propagates a rotation to another replica via refreshFromStore', async () => {
      const storePath = path.join(tmpDir, 'keys.json');
      const replicaA = new ApiKeyManager();
      replicaA.setStore(fileKeyStore(storePath));

      const created = await replicaA.transact(() => replicaA.generateKey(60, 'shared', 'free', 'viewer'));

      const replicaB = new ApiKeyManager();
      replicaB.setStore(fileKeyStore(storePath));
      await replicaB.hydrate();
      expect(replicaB.validateKey(created.key).valid).toBe(true);

      const rotated = await replicaA.transact(() => replicaA.rotateKey(created.keyHash));
      const refreshed = await replicaB.refreshFromStore();
      expect(refreshed).toBe('refreshed');

      expect(replicaB.validateKey(created.key).valid).toBe(false);
      expect(replicaB.validateKey(rotated!.key).valid).toBe(true);
    });

    it('never wipes memory when the store is empty or unavailable', async () => {
      const mgr = new ApiKeyManager();
      const generated = mgr.generateKey(60, 'kept in memory', 'free', 'viewer');

      mgr.setStore({ async load() { return null; }, async save() { /* noop */ } });
      expect(await mgr.refreshFromStore()).toBe('empty');
      expect(mgr.validateKey(generated.key).valid).toBe(true);

      mgr.setStore({
        async load() { throw new Error('connection refused'); },
        async save() { /* noop */ },
      });
      expect(await mgr.refreshFromStore()).toBe('failed');
      expect(mgr.validateKey(generated.key).valid).toBe(true);
    });
  });

  describe('failure semantics', () => {
    it('rolls the mutation back and throws KeyStoreWriteError when the store write fails', async () => {
      const mgr = new ApiKeyManager();
      const { store } = recordingStore({ failSave: true });
      mgr.setStore(store);

      const before = mgr.getAllKeys().map((k) => k.keyHash);
      let plaintext = '';

      await expect(
        mgr.transact(() => {
          const key = mgr.generateKey(60, 'doomed', 'free', 'viewer');
          plaintext = key.key;
          return key;
        }),
      ).rejects.toBeInstanceOf(KeyStoreWriteError);

      expect(mgr.validateKey(plaintext).valid).toBe(false);
      expect(mgr.getAllKeys().map((k) => k.keyHash).sort()).toEqual([...before].sort());
    });

    it('fails before applying the mutation when the store cannot be read', async () => {
      const mgr = new ApiKeyManager();
      const beforeCount = mgr.getAllKeys().length;
      mgr.setStore({
        async load() { throw new Error('connection refused'); },
        async save() { /* noop */ },
      });

      await expect(mgr.transact(() => mgr.generateKey(60, 'never created', 'free', 'viewer'))).rejects.toBeInstanceOf(
        KeyStoreWriteError,
      );
      expect(mgr.getAllKeys().length).toBe(beforeCount);
    });
  });

  describe('startup consistency: store vs environment seed', () => {
    const envPlaintext = 'sk_free_envseed0000000000000000000001';
    const envPrefix = envPlaintext.substring(0, 12);

    function conflictingStore(): Record<string, ApiKeyEntry> {
      return {
        ['d'.repeat(64)]: {
          keyHash: 'd'.repeat(64),
          keyPrefix: envPrefix,
          key: '',
          tier: 'free',
          role: 'viewer',
          rateLimitPerMin: 60,
          createdAt: 1,
          isActive: true,
        },
      };
    }

    it('reports same-prefix/different-hash conflicts at boot and retains both keys', async () => {
      vi.stubEnv('API_KEYS', `${envPlaintext}:100:env seed:free:viewer`);
      const mgr = new ApiKeyManager();
      vi.unstubAllEnvs();

      const { store, saved } = recordingStore({ loadResult: conflictingStore() });
      mgr.setStore(store);
      const boot = await mgr.hydrate();

      expect(boot.conflicts).toHaveLength(1);
      expect(boot.conflicts[0]).toEqual({
        keyPrefix: envPrefix,
        envHash: mgr.hashKey(envPlaintext),
        storeHash: 'd'.repeat(64),
      });

      const prefixes = mgr.getAllKeys().map((k) => k.keyHash);
      expect(prefixes).toContain(mgr.hashKey(envPlaintext));
      expect(prefixes).toContain('d'.repeat(64));
      expect(prefixes).toHaveLength(2);

      expect(boot.seeded).toBe(1);
      expect(saved[0][mgr.hashKey(envPlaintext)]).toBeDefined();
    });

    it('reports no conflict when the store holds the same key as the environment', async () => {
      vi.stubEnv('API_KEYS', `${envPlaintext}:100:env seed:free:viewer`);
      const mgr = new ApiKeyManager();
      vi.unstubAllEnvs();

      const envHash = mgr.hashKey(envPlaintext);
      const conflicts = mgr.compareWithStore({
        [envHash]: {
          keyHash: envHash,
          keyPrefix: envPrefix,
          key: '',
          tier: 'free',
          role: 'viewer',
          rateLimitPerMin: 100,
          createdAt: 1,
          isActive: true,
        },
      });
      expect(conflicts).toEqual([]);
    });

    it('seeds the environment keys into an empty store', async () => {
      vi.stubEnv('API_KEYS', `${envPlaintext}:100:env seed:free:viewer`);
      const mgr = new ApiKeyManager();
      vi.unstubAllEnvs();

      const { store, saved } = recordingStore();
      mgr.setStore(store);
      const boot = await mgr.hydrate();

      expect(boot.loaded).toBe(0);
      expect(boot.conflicts).toEqual([]);
      expect(saved).toHaveLength(1);
      expect(Object.keys(saved[0])).toEqual([mgr.hashKey(envPlaintext)]);
    });

    it('drops the runtime-generated default admin when the store is already authoritative', async () => {
      const mgr = new ApiKeyManager();
      expect(mgr.getAllKeys().some((k) => k.keyPrefix.startsWith('sk_admin_'))).toBe(true);

      const storeEntries: Record<string, ApiKeyEntry> = {
        ['e'.repeat(64)]: {
          keyHash: 'e'.repeat(64),
          keyPrefix: 'sk_pro_stored',
          key: '',
          tier: 'pro',
          role: 'viewer',
          rateLimitPerMin: 60,
          createdAt: 1,
          isActive: true,
        },
      };
      const { store } = recordingStore({ loadResult: storeEntries });
      mgr.setStore(store);
      const boot = await mgr.hydrate();

      expect(boot.loaded).toBe(1);
      expect(boot.seeded).toBe(0);
      expect(mgr.getAllKeys().some((k) => k.keyPrefix.startsWith('sk_admin_'))).toBe(false);
      expect(mgr.getKeyMetadata('e'.repeat(64))).not.toBeNull();
    });
  });

  describe('Issue #751: cryptographic key inventory', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function inventoryEntry(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
      return {
        keyHash: 'f'.repeat(64),
        keyPrefix: 'sk_pro_inv',
        key: '',
        tier: 'pro',
        role: 'viewer',
        rateLimitPerMin: 60,
        createdAt: 1,
        isActive: true,
        owner: 'team-payments',
        algorithm: 'ed25519',
        purpose: 'signing',
        rotationDueAt: Date.now() + 30 * DAY_MS,
        ...overrides,
      };
    }

    it('reports a complete inventory for a fully annotated key', () => {
      const mgr = new ApiKeyManager();
      const entry = inventoryEntry();
      mgr.loadKeysFromVault({ [entry.keyHash]: entry });

      const report = mgr.getKeyInventory();
      expect(report.complete).toBe(true);
      expect(report.issues).toEqual([]);
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].owner).toBe('team-payments');
      expect(report.entries[0].algorithm).toBe('ed25519');
      expect(report.entries[0].purpose).toBe('signing');
      expect(report.entries[0].rotationDueAt).toBe(entry.rotationDueAt);
    });

    it('treats a key exactly at its rotation deadline as due for rotation', () => {
      const mgr = new ApiKeyManager();
      const now = Date.now();
      const entry = inventoryEntry({ rotationDueAt: now });
      mgr.loadKeysFromVault({ [entry.keyHash]: entry });

      const report = mgr.getKeyInventory(now);
      expect(report.complete).toBe(false);
      expect(report.entries[0].rotationDue).toBe(true);
      expect(report.issues).toContainEqual({ keyHash: entry.keyHash, reason: 'rotation_due' });

      const justBefore = mgr.getKeyInventory(now - 1);
      expect(justBefore.entries[0].rotationDue).toBe(false);
      expect(justBefore.issues).toEqual([]);
    });

    it('flags missing owner and expired keys as inventory failures', () => {
      const mgr = new ApiKeyManager();
      const now = Date.now();
      const noOwner = inventoryEntry({ keyHash: '1'.repeat(64), owner: undefined });
      const expired = inventoryEntry({ keyHash: '2'.repeat(64), expiresAt: now - 1 });
      mgr.loadKeysFromVault({ [noOwner.keyHash]: noOwner, [expired.keyHash]: expired });

      const report = mgr.getKeyInventory(now);
      expect(report.complete).toBe(false);
      expect(report.issues).toContainEqual({ keyHash: noOwner.keyHash, reason: 'missing_owner' });
      expect(report.issues).toContainEqual({ keyHash: expired.keyHash, reason: 'expired' });
    });
  });

  describe('admin API routes persist before responding', () => {
    let app: express.Express;
    let adminKey: string;
    let snapshot: Record<string, ApiKeyMetadata>;

    beforeEach(() => {
      snapshot = apiKeyManager.snapshot();
      app = express();
      app.use(express.json());
      app.use('/admin', adminRouter);
      adminKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.admin, 'route test admin', 'admin', 'admin').key;
    });

    afterEach(() => {
      apiKeyManager.setStore(null);
      apiKeyManager.restore(snapshot);
    });

    it('POST /admin/keys writes the new key to the store before returning 201', async () => {
      const { store, saved } = recordingStore();
      apiKeyManager.setStore(store);

      const res = await request(app)
        .post('/admin/keys')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tier: 'free', role: 'viewer', rateLimitPerMin: 60, description: 'created via route' });

      expect(res.status).toBe(201);
      expect(saved).toHaveLength(1);
      expect(saved[0][res.body.data.keyHash]).toBeDefined();
      expect(saved[0][res.body.data.keyHash].key).toBe('');
      expect(saved[0][res.body.data.keyHash].description).toBe('created via route');
    });

    it('POST /admin/keys returns 500 KEY_STORE_WRITE_FAILED and creates nothing when the store write fails', async () => {
      const { store } = recordingStore({ failSave: true });
      apiKeyManager.setStore(store);
      const before = apiKeyManager.getAllKeys().length;

      const res = await request(app)
        .post('/admin/keys')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tier: 'free', role: 'viewer', rateLimitPerMin: 60, description: 'doomed' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('KEY_STORE_WRITE_FAILED');
      expect(apiKeyManager.getAllKeys().length).toBe(before);
    });

    it('POST /admin/keys/:keyHash/rotate persists the rotation (new hash in, old hash out)', async () => {
      const { store, saved } = recordingStore();
      apiKeyManager.setStore(store);
      const target = apiKeyManager.generateKey(60, 'rotate target', 'free', 'viewer');

      const res = await request(app)
        .post(`/admin/keys/${target.keyHash}/rotate`)
        .set('Authorization', `Bearer ${adminKey}`);

      expect(res.status).toBe(200);
      expect(saved.length).toBeGreaterThan(0);
      const persisted = saved[saved.length - 1];
      expect(persisted[res.body.data.keyHash]).toBeDefined();
      expect(persisted[target.keyHash]).toBeUndefined();
      expect(persisted[res.body.data.keyHash].key).toBe('');
    });

    it('a failed store write on rotation returns 500 and keeps the old key valid', async () => {
      const { store } = recordingStore({ failSave: true });
      apiKeyManager.setStore(store);
      const target = apiKeyManager.generateKey(60, 'survives failure', 'free', 'viewer');

      const res = await request(app)
        .post(`/admin/keys/${target.keyHash}/rotate`)
        .set('Authorization', `Bearer ${adminKey}`);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('KEY_STORE_WRITE_FAILED');
      expect(apiKeyManager.validateKey(target.key).valid).toBe(true);
      expect(apiKeyManager.findByHash(target.keyHash)).not.toBeNull();
    });
  });
});
