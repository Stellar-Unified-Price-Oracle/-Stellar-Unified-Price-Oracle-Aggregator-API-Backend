import { readFileSync, writeFileSync } from 'node:fs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4010');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Only local sandbox recording is supported');
const file = new URL('../services/aggregator/tests/fixtures/provider-transport/v1.json', import.meta.url);
const fixture = JSON.parse(readFileSync(file, 'utf8'));
for (const record of fixture.records) {
  if (record.status !== 'current') continue;
  const request = new URL(record.request.path, base);
  for (const [key, value] of Object.entries(record.request.params)) {
    if (value !== '[REDACTED]') request.searchParams.set(key, value);
  }
  const response = await fetch(request);
  if (response.status !== 200) throw new Error(`Recording failed: ${record.provider} HTTP ${response.status}`);
  record.response = { status: response.status, body: await response.json() };
  record.provenance.recordedAt = new Date().toISOString();
  const body = record.response.body;
  const entry = record.provider === 'band' ? body.data : record.provider === 'reflector' ? body.prices['Crypto.XLM/USD'] : record.provider === 'redstone' ? body.XLM : body.USD;
  const decimals = entry.decimals ?? 8;
  record.expected = { asset: 'XLM', price: (12n * 10n ** BigInt(decimals - 2)).toString(), decimals, observedAt: entry.updated_at ?? entry.timestamp ?? null };
}
writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('Recorded four local provider transports; inspect the diff before committing.');
