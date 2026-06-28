import crypto from 'crypto';

/**
 * Encryption at rest for sensitive configuration and historical data (issue #41).
 *
 * Uses AES-256-GCM (authenticated encryption). Encrypted payloads are tagged
 * with a version + key id so the decryption side can support key rotation:
 * data encrypted under a previous key keeps decrypting after the active key is
 * rotated, as long as the old key is supplied via ENCRYPTION_KEY_PREVIOUS.
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

/** Normalize a key string (hex, base64, or passphrase) into a 32-byte buffer. */
function deriveKey(raw: string): Buffer {
  // 64 hex chars → raw 32-byte key
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');

  // base64 that decodes to exactly 32 bytes
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    /* fall through to scrypt */
  }

  // Otherwise derive deterministically from the passphrase.
  return crypto.scryptSync(raw, KEY_DERIVATION_SALT, 32);
}

/** Short, stable identifier for a key, used to select the right key on decrypt. */
function keyId(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export interface EncryptionKeys {
  active: string;
  previous?: string;
}

function loadKeys(explicit?: EncryptionKeys): { active: Buffer | null; all: Map<string, Buffer> } {
  const activeRaw = explicit?.active ?? process.env.ENCRYPTION_KEY ?? '';
  const previousRaw = explicit?.previous ?? process.env.ENCRYPTION_KEY_PREVIOUS ?? '';

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

export function isEncryptionConfigured(explicit?: EncryptionKeys): boolean {
  return loadKeys(explicit).active !== null;
}

/**
 * Encrypt a UTF-8 string. Returns the `enc:` payload, or the original value
 * unchanged when no encryption key is configured.
 */
export function encrypt(plaintext: string, explicit?: EncryptionKeys): string {
  const { active } = loadKeys(explicit);
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

/**
 * Decrypt an `enc:` payload. Plain (unencrypted) values are returned as-is so
 * config can mix encrypted and plaintext entries during migration.
 */
export function decrypt(value: string, explicit?: EncryptionKeys): string {
  if (!isEncrypted(value)) return value;

  const parts = value.split(':');
  if (parts.length !== 6) {
    throw new Error('Malformed encrypted payload');
  }
  const [, , id, ivB64, tagB64, dataB64] = parts;

  const { all } = loadKeys(explicit);
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

/**
 * Decrypt a sensitive configuration value if it is encrypted; otherwise return
 * it unchanged. Safe to call on every env-sourced secret.
 */
export function decryptSecret(value: string): string {
  try {
    return decrypt(value);
  } catch {
    // Never crash config loading on a bad payload — surface the raw value and
    // let downstream validation fail loudly instead.
    return value;
  }
}
