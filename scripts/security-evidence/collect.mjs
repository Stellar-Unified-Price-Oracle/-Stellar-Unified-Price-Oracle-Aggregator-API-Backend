#!/usr/bin/env node
// Usage: node scripts/security-evidence/collect.mjs --start <ISO> --end <ISO> [--out file] [--exceptions file]
// Usage: node scripts/security-evidence/collect.mjs --verify <evidence.json>   (checks reviewer sign-off)
// Exit: 0 ok, 1 control failures / sign-off problems, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEvidence, validateSignOff } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

if (opt('--verify')) {
  const problems = validateSignOff(JSON.parse(fs.readFileSync(opt('--verify'), 'utf8')));
  problems.forEach((p) => console.error(`sign-off: ${p}`));
  process.exit(problems.length ? 1 : 0);
}

const start = opt('--start');
const end = opt('--end');
if (!start || !end) { console.error('--start and --end (ISO dates) are required'); process.exit(2); }
let evidence;
try {
  const controls = JSON.parse(fs.readFileSync(path.join(here, 'controls.json'), 'utf8'));
  const exFile = opt('--exceptions');
  const exceptions = exFile ? JSON.parse(fs.readFileSync(exFile, 'utf8')) : [];
  evidence = collectEvidence({ controls, root, periodStart: start, periodEnd: end, exceptions });
} catch (e) { console.error(`error: ${e.message}`); process.exit(2); }

const out = opt('--out');
const text = JSON.stringify(evidence, null, 2) + '\n';
if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
process.exit(evidence.summary.fail > 0 ? 1 : 0);
