import crypto from 'crypto';
import { config } from '../config';

/**
 * Stateless CSRF tokens for WebSocket upgrades (issue #40).
 *
 * A token is an HMAC over an issue timestamp using a server-side secret. It is
 * handed to authenticated clients over HTTP and must be presented (as the
 * `token` query parameter) when opening a WebSocket connection. Because the
 * token is bound to the secret and carries an expiry, it cannot be forged by a
 * cross-site attacker who never sees the secret.
 */

export function isCsrfEnabled(): boolean {
  return config.ws.csrfSecret.length > 0;
}

export function issueWsCsrfToken(): string {
  const issuedAt = Date.now().toString();
  const signature = sign(issuedAt);
  return Buffer.from(`${issuedAt}.${signature}`).toString('base64url');
}

export function verifyWsCsrfToken(token: string | undefined): boolean {
  if (!isCsrfEnabled()) return true;
  if (!token) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    return false;
  }

  const [issuedAt, signature] = decoded.split('.');
  if (!issuedAt || !signature) return false;

  const expected = sign(issuedAt);
  if (!timingSafeEqual(signature, expected)) return false;

  const age = Date.now() - parseInt(issuedAt, 10);
  return Number.isFinite(age) && age >= 0 && age <= config.ws.csrfTtlMs;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.ws.csrfSecret).update(payload).digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
