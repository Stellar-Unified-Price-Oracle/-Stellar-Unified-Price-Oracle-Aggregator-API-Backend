#!/usr/bin/env node
// Residue scanner for data-subject deletion (issue #755).
// Usage: node scripts/verify-consumer-deletion.mjs --subject <id> --manifest <manifest.json> [--json]
//
// The manifest lists every location that may hold derived consumer data:
// {
//   "stores": [
//     { "name": "dsar-store", "kind": "primary|cache|export|replica|backup",
//       "paths": ["data/dsar.json"],           // files or directories, scanned recursively
//       "exception": "optional documented reason residue is allowed",
//       "boundedDays": 35                      // required when exception is set
//     }
//   ]
// }
// A store passes when no file contains the subject id, its sha256, or its sha256 prefix (16 hex).
// A store with a documented exception and boundedDays is reported as "excepted", not as a failure.
// Exit codes: 0 all clean or excepted, 1 residue found, 2 usage or input error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KINDS = new Set(['primary', 'cache', 'export', 'replica', 'backup']);
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function needles(subject) {
  const hash = crypto.createHash('sha256').update(subject).digest('hex');
  return [subject, hash, hash.slice(0, 16)];
}

export function* walk(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) yield* walk(path.join(target, name));
  } else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
    yield target;
  }
}

export function scanStore(store, subject) {
  const hits = [];
  const missing = [];
  const keys = needles(subject);
  for (const p of store.paths ?? []) {
    if (!fs.existsSync(p)) {
      missing.push(p);
      continue;
    }
    for (const file of walk(p)) {
      const text = fs.readFileSync(file, 'latin1');
      if (keys.some((k) => text.includes(k))) hits.push(file);
    }
  }
  return { hits, missing };
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || !Array.isArray(manifest.stores) || manifest.stores.length === 0) {
    return ['manifest.stores must be a non-empty array'];
  }
  manifest.stores.forEach((s, i) => {
    if (!s.name) errors.push(`stores[${i}].name missing`);
    if (!KINDS.has(s.kind)) errors.push(`stores[${i}].kind must be one of ${[...KINDS].join(', ')}`);
    if (!Array.isArray(s.paths) || s.paths.length === 0) errors.push(`stores[${i}].paths must be a non-empty array`);
    if (s.exception && !(Number.isFinite(s.boundedDays) && s.boundedDays > 0)) {
      errors.push(`stores[${i}] has an exception but no positive boundedDays`);
    }
  });
  return errors;
}

export function verify(manifest, subject) {
  const results = manifest.stores.map((store) => {
    const { hits, missing } = scanStore(store, subject);
    let status = 'clean';
    if (hits.length) status = store.exception ? 'excepted' : 'residue';
    return {
      store: store.name,
      kind: store.kind,
      status,
      hits,
      missingPaths: missing,
      ...(store.exception && { exception: store.exception, boundedDays: store.boundedDays }),
    };
  });
  return { subjectChecked: crypto.createHash('sha256').update(subject).digest('hex').slice(0, 16), results, ok: results.every((r) => r.status !== 'residue') };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const subject = opt('--subject');
  const manifestPath = opt('--manifest');
  if (!subject || !manifestPath) {
    console.error('usage: verify-consumer-deletion.mjs --subject <id> --manifest <manifest.json> [--json]');
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`cannot read manifest: ${err.message}`);
    process.exit(2);
  }
  const errors = validateManifest(manifest);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(2);
  }
  const report = verify(manifest, subject);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // The raw subject id is never printed; only a hash prefix identifies the check.
    console.log(`subject sha256 prefix: ${report.subjectChecked}`);
    for (const r of report.results) console.log(`${r.status.toUpperCase().padEnd(9)} ${r.kind.padEnd(8)} ${r.store} (${r.hits.length} file(s))`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
