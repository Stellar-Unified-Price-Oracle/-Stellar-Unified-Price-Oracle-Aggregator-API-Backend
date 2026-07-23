import { createHmac, timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';

const SIGNATURE_TTL_MS = 30_000;
const usedNonces = new Map<string, number>();

function pruneNonces(): void {
  const cutoff = Date.now() - SIGNATURE_TTL_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}

export function signPayload(secret: string, timestamp: number, nonce: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

export function verifyWsSignature(req: IncomingMessage, secret: string): { valid: boolean; error?: string } {
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

  const expected = signPayload(secret, timestamp, nonce, '');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'Invalid signature' };
  }

  usedNonces.set(nonce, now);
  return { valid: true };
}
