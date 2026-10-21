import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { z } from 'zod';

const leaseSchema = z.object({
  version: z.literal(1),
  environment: z.literal('sandbox'),
  provider: z.literal('chainlink'),
  origin: z.string().url(),
  token: z.string().regex(/^sbx_[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();
export type SandboxLease = z.infer<typeof leaseSchema>;

export class SandboxCredentialError extends Error {
  name = 'SandboxCredentialError';
  constructor() { super('Sandbox credential policy rejected the request'); }
}

export function assertSandboxOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new SandboxCredentialError();
  return url.origin;
}

export function assertSandboxIsolation(env: NodeJS.ProcessEnv): void {
  const isolated = env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || env.PROVIDER_ENVIRONMENT === 'sandbox';
  if (!isolated) return;
  for (const [key, value] of Object.entries(env)) {
    if (/^(CHAINLINK|REDSTONE|BAND|REFLECTOR)_API_KEY(?:_|$)/.test(key) && value?.trim()) throw new SandboxCredentialError();
  }
  for (const key of Object.keys(env)) {
    if (/^(CHAINLINK|REDSTONE|BAND|REFLECTOR)_BASE_URL(?:_|$)/.test(key) && env[key]) assertSandboxOrigin(env[key]!);
  }
}

export function readSandboxLease(file: string, origin: string, now = Date.now()): SandboxLease {
  try {
    const parsed = leaseSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) throw new SandboxCredentialError();
    const lease = parsed.data;
    if (lease.origin !== assertSandboxOrigin(origin) || now < lease.issuedAt || now >= lease.expiresAt || lease.expiresAt - lease.issuedAt > 86_400_000) throw new SandboxCredentialError();
    return lease;
  } catch {
    throw new SandboxCredentialError();
  }
}

export function rotateSandboxLease(file: string, origin: string, ttlMs = 3_600_000, now = Date.now()): SandboxLease {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86_400_000) throw new SandboxCredentialError();
  const lease: SandboxLease = {
    version: 1, environment: 'sandbox', provider: 'chainlink', origin: assertSandboxOrigin(origin),
    token: `sbx_${randomBytes(32).toString('hex')}`, issuedAt: now, expiresAt: now + ttlMs,
  };
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* The atomic rename removes the temporary file. */ }
  }
  return lease;
}

export function sandboxTokenMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function providerApiKey(origin: string, fallback: string, env = process.env): string {
  assertSandboxIsolation(env);
  if (env.PROVIDER_ENVIRONMENT !== 'sandbox' && env.NODE_ENV !== 'test' && env.NODE_ENV !== 'development') return fallback;
  if (fallback) throw new SandboxCredentialError();
  assertSandboxOrigin(origin);
  if (!env.SANDBOX_PROVIDER_LEASE_FILE) return '';
  return readSandboxLease(env.SANDBOX_PROVIDER_LEASE_FILE, origin).token;
}
