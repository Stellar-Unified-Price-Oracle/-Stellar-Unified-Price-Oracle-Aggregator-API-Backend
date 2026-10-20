import { createHmac, timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';

const SIGNATURE_TTL_MS = 30_000;
const usedNonces = new Map<string, number>();

export type KeyAlgorithm = 'hmac-sha256' | 'hmac-sha512';

export interface KeyInventoryEntry {
  /** Stable identifier for the key (never the secret material itself). */
  keyId: string;
  /** Owning team or role accountable for rotation and retirement. */
  owner: string;
  /** Purpose of the key within the WS signing flow. */
  purpose: 'ws-signing';
  algorithm: KeyAlgorithm;
  /** ISO-8601 date the key was activated. */
  activatedAt: string;
  /** ISO-8601 date the key must be rotated by. */
  rotateBy: string;
  /** ISO-8601 date after which the key must no longer be accepted. */
  retireAt: string;
  /** Algorithm transition plan, if the key is being migrated. */
  transition?: {
    toAlgorithm: KeyAlgorithm;
    /** ISO-8601 date the transition must complete. */
    completeBy: string;
    notes: string;
  };
}

/**
 * Owner-mapped inventory of WS signing keys. Secrets are referenced by keyId
 * only; the actual secret material is supplied via configuration/secret store.
 */
export const WS_SIGNING_KEY_INVENTORY: readonly KeyInventoryEntry[] = [
  {
    keyId: 'ws-signing-primary',
    owner: 'platform-security',
    purpose: 'ws-signing',
    algorithm: 'hmac-sha256',
    activatedAt: '2024-01-01',
    rotateBy: '2025-01-01',
    retireAt: '2025-04-01',
    transition: {
      toAlgorithm: 'hmac-sha512',
      completeBy: '2025-01-01',
      notes: 'Dual-accept sha256/sha512 during transition; drop sha256 at retireAt.',
    },
  },
];

export function getKeyInventoryEntry(keyId: string): KeyInventoryEntry | undefined {
  return WS_SIGNING_KEY_INVENTORY.find((entry) => entry.keyId === keyId);
}

/**
 * Returns inventory entries whose rotateBy or retireAt dates have passed as of
 * `now`, so operators can be alerted before keys go stale.
 */
export function findOverdueKeys(now: Date = new Date()): KeyInventoryEntry[] {
  const iso = now.toISOString().slice(0, 10);
  return WS_SIGNING_KEY_INVENTORY.filter(
    (entry) => entry.rotateBy < iso || entry.retireAt < iso,
  );
}

function pruneNonces(): void {
  const cutoff = Date.now() - SIGNATURE_TTL_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}

export function signPayload(
  secret: string,
  timestamp: number,
  nonce: string,
  body: string,
  algorithm: KeyAlgorithm = 'hmac-sha256',
): string {
  return createHmac(algorithm, secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

export function verifyWsSignature(
  req: IncomingMessage,
  secret: string,
  algorithm: KeyAlgorithm = 'hmac-sha256',
): { valid: boolean; error?: string } {
  if (!secret) return { valid: true };

  const url = new URL(req.url || '', 'ws://host');
  const timestamp = parseInt(url.searchParams.get('ts') || '0', 10);
  const nonce = url.searchParams.get('nonce') || '';
  const signature = url.searchParams.get('sig') || '';

  if (!timestamp || !nonce || !signature) {
    return { valid: false, error: 'Missing ts, nonce, or sig query parameters' };
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > SIGNATURE_TTL_MS) {
    return { valid: false, error: 'Timestamp out of acceptable range (±30s)' };
  }

  pruneNonces();
  if (usedNonces.has(nonce)) {
    return { valid: false, error: 'Nonce already used (replay detected)' };
  }

  const expected = signPayload(secret, timestamp, nonce, '', algorithm);
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'Invalid signature' };
  }

  usedNonces.set(nonce, now);
  return { valid: true };
}
