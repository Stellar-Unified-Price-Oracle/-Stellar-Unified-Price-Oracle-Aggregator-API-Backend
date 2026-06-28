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
