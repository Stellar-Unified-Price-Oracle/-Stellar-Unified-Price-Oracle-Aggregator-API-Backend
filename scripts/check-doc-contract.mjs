#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir) { return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.md') ? [`${dir}/${entry.name}`] : []); }
const failures = [];
for (const rel of walk('docs')) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  if ((rel.startsWith('docs/runbooks/') || rel.startsWith('docs/architecture/') || /design/i.test(path.basename(rel))) && (!/^\*\*Owner:\*\*\s*.+/m.test(text) || !/^\*\*Review date:\*\*\s*\d{4}-\d{2}-\d{2}/m.test(text))) failures.push(`${rel}: runbook/design claim requires **Owner:** and **Review date:** YYYY-MM-DD metadata`);
  for (const match of text.matchAll(/(?:`|\]\()((?:api|services|packages|contracts|scripts|monitoring|k8s|\.github)\/[A-Za-z0-9_./-]+)(?:`|\))/g)) {
    const candidate = match[1].replace(/[),.;:]$/, '');
    if (!fs.existsSync(path.join(root, candidate))) failures.push(`${rel}: referenced repository path ${candidate} does not exist`);
  }
}
if (failures.length) { console.error(failures.map((failure) => `FAIL ${failure}`).join('\n')); process.exit(1); }
console.log('Documentation path and ownership/review checks passed.');
