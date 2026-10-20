import { readSandboxLease, rotateSandboxLease } from '../services/aggregator/src/oracle-sources/sandbox-credentials';

const [file, origin, ttl = '3600000', mode] = process.argv.slice(2);
if (!file || !origin || (mode && mode !== '--watch')) throw new Error('Usage: tsx scripts/rotate-sandbox-provider-credentials.ts FILE LOOPBACK_ORIGIN [TTL_MS] [--watch]');
const ttlMs = Number(ttl);
if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) throw new Error('TTL must be an integer between 1000 and 86400000ms');
function renew(): void {
  let rotate = true;
  try {
    const lease = readSandboxLease(file, origin);
    rotate = lease.expiresAt - Date.now() <= ttlMs / 4;
  } catch { rotate = true; }
  if (rotate) rotateSandboxLease(file, origin, ttlMs);
  console.log(JSON.stringify({ environment: 'sandbox', rotated: rotate, expiresAt: readSandboxLease(file, origin).expiresAt }));
}
renew();
if (mode === '--watch') {
  const timer = setInterval(() => {
    try { renew(); } catch {
      console.error('Sandbox credential renewal failed');
      clearInterval(timer);
      process.exitCode = 1;
    }
  }, Math.min(60000, Math.max(100, Math.floor(ttlMs / 8))));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => clearInterval(timer));
}
