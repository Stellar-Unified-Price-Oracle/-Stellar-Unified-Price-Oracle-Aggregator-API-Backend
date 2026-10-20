import crypto from 'crypto';

/**
 * Encryption at rest for sensitive configuration and historical data (issue #41).
 *
 * AES-256-GCM authenticated encryption. Payloads are versioned and tagged with
 * a key id to support key rotation (data encrypted under a retired key keeps
 * decrypting while that key is supplied via ENCRYPTION_KEY_PREVIOUS).
 *
 * This mirrors the aggregator's crypto util so both services interoperate on
 * the same on-disk format and the same ENCRYPTION_KEY.
 *
 * Payload format (string):  enc:v1:<keyId>:<iv_b64>:<tag_b64>:<ciphertext_b64>
 */

const PREFIX = 'enc';
const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const KEY_DERIVATION_SALT = 'stellar-oracle-encryption-v1';

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:${VERSION}:`);
}

function deriveKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    /* fall through to scrypt */
  }
  return crypto.scryptSync(raw, KEY_DERIVATION_SALT, 32);
}

function keyId(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function loadKeys(): { active: Buffer | null; all: Map<string, Buffer> } {
  const activeRaw = process.env.ENCRYPTION_KEY || '';
  const previousRaw = process.env.ENCRYPTION_KEY_PREVIOUS || '';
  const all = new Map<string, Buffer>();
  let active: Buffer | null = null;

  if (activeRaw) {
    active = deriveKey(activeRaw);
    all.set(keyId(active), active);
  }
  if (previousRaw) {
    const prev = deriveKey(previousRaw);
    all.set(keyId(prev), prev);
  }
  return { active, all };
}

export function isEncryptionConfigured(): boolean {
  return loadKeys().active !== null;
}

export function encrypt(plaintext: string): string {
  const { active } = loadKeys();
  if (!active) return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, active, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX,
    VERSION,
    keyId(active),
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decrypt(value: string): string {
  if (!isEncrypted(value)) return value;

  const parts = value.split(':');
  if (parts.length !== 6) throw new Error('Malformed encrypted payload');
  const [, , id, ivB64, tagB64, dataB64] = parts;

  const { all } = loadKeys();
  const key = all.get(id);
  if (!key) {
    throw new Error(`No encryption key available for key id "${id}" (rotate via ENCRYPTION_KEY_PREVIOUS)`);
  }

  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf-8');
}

export function decryptSecret(value: string): string {
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

/**
 * Cryptographic key inventory (issue #751).
 *
 * Owner-mapped registry of signing, encryption, and verification keys with
 * rotation, retirement, and algorithm transition requirements. Entries are
 * declared statically here and reconciled against the keys actually loaded
 * from the environment (ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS) so drift is
 * visible to operators.
 */

export type KeyPurpose = 'signing' | 'encryption' | 'verification';
export type KeyAlgorithm = 'aes-256-gcm' | 'ed25519' | 'secp256k1' | 'hmac-sha256';
export type KeyStatus = 'active' | 'rotating' | 'retiring' | 'retired';

export interface KeyInventoryEntry {
  /** Stable identifier referenced by payloads / signatures. */
  id: string;
  /** Accountable owner (team or role) for rotation and retirement. */
  owner: string;
  purpose: KeyPurpose;
  algorithm: KeyAlgorithm;
  status: KeyStatus;
  /** ISO-8601 date the key entered service. */
  createdAt: string;
  /** ISO-8601 date by which the key must be rotated. */
  rotateBy: string;
  /** ISO-8601 date after which the key must no longer be used to sign/encrypt. */
  retireBy: string;
  /** Where the key material is sourced from (env var, KMS, etc.). */
  source: string;
  /** Algorithm transition plan, if this key is being migrated. */
  transition?: {
    toAlgorithm: KeyAlgorithm;
    /** ISO-8601 date the transition must complete. */
    completeBy: string;
    notes: string;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Declarative inventory. Keep in sync with the keys provisioned in each
 * environment; `validateKeyInventory` flags missing/expired entries.
 */
export const KEY_INVENTORY: readonly KeyInventoryEntry[] = [
  {
    id: 'enc-active',
    owner: 'security-platform',
    purpose: 'encryption',
    algorithm: 'aes-256-gcm',
    status: 'active',
    createdAt: '2024-01-01',
    rotateBy: '2025-01-01',
    retireBy: '2026-01-01',
    source: 'ENCRYPTION_KEY',
  },
  {
    id: 'enc-previous',
    owner: 'security-platform',
    purpose: 'encryption',
    algorithm: 'aes-256-gcm',
    status: 'rotating',
    createdAt: '2023-01-01',
    rotateBy: '2024-01-01',
    retireBy: '2025-01-01',
    source: 'ENCRYPTION_KEY_PREVIOUS',
    transition: {
      toAlgorithm: 'aes-256-gcm',
      completeBy: '2025-01-01',
      notes: 'Re-encrypt remaining payloads under enc-active, then unset ENCRYPTION_KEY_PREVIOUS.',
    },
  },
  {
    id: 'oracle-signing',
    owner: 'oracle-core',
    purpose: 'signing',
    algorithm: 'ed25519',
    status: 'active',
    createdAt: '2024-01-01',
    rotateBy: '2025-01-01',
    retireBy: '2026-01-01',
    source: 'ORACLE_SIGNING_KEY',
  },
  {
    id: 'oracle-verification',
    owner: 'oracle-core',
    purpose: 'verification',
    algorithm: 'ed25519',
    status: 'active',
    createdAt: '2024-01-01',
    rotateBy: '2025-01-01',
    retireBy: '2026-01-01',
    source: 'ORACLE_VERIFICATION_KEY',
  },
];

export interface KeyInventoryIssue {
  keyId: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface KeyInventoryReport {
  generatedAt: string;
  entries: KeyInventoryEntry[];
  issues: KeyInventoryIssue[];
  /** Key ids currently loaded from the environment. */
  loadedKeyIds: string[];
}

function parseDate(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Validate the inventory against `now` and the keys currently loaded from the
 * environment. Pure with respect to its inputs so it is easy to test.
 */
export function validateKeyInventory(
  entries: readonly KeyInventoryEntry[] = KEY_INVENTORY,
  now: Date = new Date(),
  loadedKeyIds: readonly string[] = Array.from(loadKeys().all.keys()),
): KeyInventoryIssue[] {
  const issues: KeyInventoryIssue[] = [];
  const seen = new Set<string>();
  const nowMs = now.getTime();

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      issues.push({ keyId: entry.id, severity: 'error', message: 'Duplicate key id in inventory' });
    }
    seen.add(entry.id);

    if (!entry.owner) {
      issues.push({ keyId: entry.id, severity: 'error', message: 'Missing owner' });
    }

    const created = parseDate(entry.createdAt);
    const rotateBy = parseDate(entry.rotateBy);
    const retireBy = parseDate(entry.retireBy);

    if (Number.isNaN(created) || Number.isNaN(rotateBy) || Number.isNaN(retireBy)) {
      issues.push({ keyId: entry.id, severity: 'error', message: 'Invalid ISO-8601 date' });
      continue;
    }
    if (!(created <= rotateBy && rotateBy <= retireBy)) {
      issues.push({
        keyId: entry.id,
        severity: 'error',
        message: 'Dates must satisfy createdAt <= rotateBy <= retireBy',
      });
    }

    if (entry.status !== 'retired' && nowMs > retireBy) {
      issues.push({
        keyId: entry.id,
        severity: 'error',
        message: `Key passed retireBy (${entry.retireBy}) but status is "${entry.status}"`,
      });
    } else if (entry.status !== 'retired' && nowMs > rotateBy) {
      issues.push({
        keyId: entry.id,
        severity: 'warning',
        message: `Key passed rotateBy (${entry.rotateBy}); rotation overdue`,
      });
    }

    if (entry.transition) {
      const completeBy = parseDate(entry.transition.completeBy);
      if (Number.isNaN(completeBy)) {
        issues.push({ keyId: entry.id, severity: 'error', message: 'Invalid transition completeBy date' });
      } else if (nowMs > completeBy) {
        issues.push({
          keyId: entry.id,
          severity: 'error',
          message: `Algorithm transition to ${entry.transition.toAlgorithm} overdue (${entry.transition.completeBy})`,
        });
      }
    }

    if (entry.purpose === 'encryption' && entry.status !== 'retired' && !loadedKeyIds.includes(entry.id)) {
      // Encryption entries are declared by role; the loaded set is keyed by
      // derived key id, so this is informational only.
      issues.push({
        keyId: entry.id,
        severity: 'warning',
        message: 'Encryption key not present in loaded key set',
      });
    }
  }

  return issues;
}

export function buildKeyInventoryReport(
  now: Date = new Date(),
  entries: readonly KeyInventoryEntry[] = KEY_INVENTORY,
): KeyInventoryReport {
  const loadedKeyIds = Array.from(loadKeys().all.keys());
  return {
    generatedAt: now.toISOString(),
    entries: entries.map((e) => ({ ...e })),
    issues: validateKeyInventory(entries, now, loadedKeyIds),
    loadedKeyIds,
  };
}

/** Days until the key must be rotated (negative when overdue). */
export function daysUntilRotation(entry: KeyInventoryEntry, now: Date = new Date()): number {
  const rotateBy = parseDate(entry.rotateBy);
  if (Number.isNaN(rotateBy)) return NaN;
  return Math.floor((rotateBy - now.getTime()) / DAY_MS);
}
