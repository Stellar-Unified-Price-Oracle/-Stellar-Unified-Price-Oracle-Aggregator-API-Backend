#!/usr/bin/env node
// Consumer-side readiness probe (no dependencies, Node 18+).
// Usage: node scripts/integrator-readiness-probe.mjs <base-url> <path> [--max-age-sec=60] [--timeout-ms=5000]
// Reads the API key from env ORACLE_API_KEY (never from argv, never printed).
const [base, path = '/'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (n, d) => Number((process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d);
const maxAge = opt('max-age-sec', 60);
const timeoutMs = opt('timeout-ms', 5000);
if (!base) { console.error('usage: integrator-readiness-probe.mjs <base-url> <path>'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const get = async (headers) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(new URL(path, base), { headers, signal: ac.signal }); } finally { clearTimeout(t); }
};

try {
  const key = process.env.ORACLE_API_KEY;
  check('https-or-localhost', base.startsWith('https://') || /^http:\/\/(localhost|127\.)/.test(base), base.split('/')[2]);
  const bad = await get({ 'x-api-key': 'invalid-probe-key' });
  check('rejects-invalid-key', bad.status === 401 || bad.status === 403, `status ${bad.status}`);
  const res = await get(key ? { 'x-api-key': key } : {});
  check('responds-within-timeout', res.ok, `status ${res.status}`);
  const retryAfter = res.headers.get('retry-after');
  if (res.status === 429) check('retry-after-present-on-429', retryAfter !== null, String(retryAfter));
  if (res.ok) {
    const body = await res.json();
    const price = Number(body?.price ?? body?.data?.price);
    const ts = Date.parse(body?.timestamp ?? body?.data?.timestamp ?? '');
    check('price-is-finite-positive', Number.isFinite(price) && price > 0, String(price));
    const age = (Date.now() - ts) / 1000;
    check('price-fresh', Number.isFinite(age) && age <= maxAge, `age ${Number.isFinite(age) ? age.toFixed(1) : 'unknown'}s, max ${maxAge}s`);
  }
} catch (e) {
  check('request-completed', false, e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message);
}

console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
