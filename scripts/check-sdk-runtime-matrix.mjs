#!/usr/bin/env node
// Validates docs/sdk/runtime-compatibility-matrix.json.
// Fails on malformed entries, unknown statuses, tested runtimes with no test
// date, expired support windows still marked "supported", and stale reviews.
// Usage: node scripts/check-sdk-runtime-matrix.mjs [--today YYYY-MM-DD] [file]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const ti = args.indexOf('--today');
const today = ti >= 0 ? args.splice(ti, 2)[1] : new Date().toISOString().slice(0, 10);
const file = args[0] ?? 'docs/sdk/runtime-compatibility-matrix.json';
const STATUSES = new Set(['supported', 'deprecated', 'best-effort', 'unsupported']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const errors = [];
const err = (m) => errors.push(m);

let m;
try { m = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }

if (!Array.isArray(m.sdks) || m.sdks.length === 0) err('sdks must be a non-empty array');
if (!Array.isArray(m.schemaVersions) || !m.schemaVersions.every(Number.isInteger)) err('schemaVersions must be an integer array');
for (const k of ['supportedServer', 'contractAbi', 'owner']) if (typeof m[k] !== 'string' || !m[k]) err(`${k} must be a non-empty string`);
if (!DATE.test(m.lastReviewed ?? '')) err('lastReviewed must be YYYY-MM-DD');
else if ((Date.parse(today) - Date.parse(m.lastReviewed)) / 86400000 > 120) err(`matrix last reviewed ${m.lastReviewed}; review is overdue (>120 days)`);

for (const sdk of m.sdks ?? []) {
  if (!sdk.name || !sdk.language) err('sdk entry needs name and language');
  const seen = new Set();
  for (const r of sdk.runtimes ?? []) {
    const id = `${sdk.name}/${r.runtime}@${r.version}`;
    if (seen.has(id)) err(`${id}: duplicate entry`);
    seen.add(id);
    if (!STATUSES.has(r.status)) err(`${id}: invalid status "${r.status}"`);
    if (r.status === 'supported' && !DATE.test(r.tested ?? '')) err(`${id}: supported runtimes must have a tested date`);
    if (r.supportEnds != null) {
      if (!DATE.test(r.supportEnds)) err(`${id}: supportEnds must be YYYY-MM-DD or null`);
      else if (r.status === 'supported' && r.supportEnds < today) err(`${id}: support window ended ${r.supportEnds} but status is supported`);
    }
  }
  if (!(sdk.runtimes ?? []).some((r) => r.status === 'supported')) err(`${sdk.name}: no supported runtime listed`);
}

if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); process.exit(1); }
console.log(`runtime matrix OK (${m.sdks.length} SDKs, reviewed ${m.lastReviewed})`);
