#!/usr/bin/env node
/**
 * Enforces the CI workflow inventory (issue #627): every workflow file is
 * classified exactly once, has a name and concurrency, and scheduled drills
 * route their outcome to a durable issue.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
const INVENTORY = path.join(ROOT, 'docs/CI_WORKFLOWS.md');
const CLASSIFICATIONS = new Set([
  'Blocking gate',
  'Post-merge verification',
  'Scheduled drill',
  'Reporting',
]);

export function parseInventory(markdown) {
  const section = markdown.split(/^## Inventory\s*$/m)[1]?.split(/^##\s/m)[0] ?? '';
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const match = cells[0]?.match(/^`([^`]+\.ya?ml)`$/);
    if (!match) continue;
    rows.push({ file: match[1], classification: cells[1], owner: cells[2], authority: cells[3] });
  }
  return rows;
}

export function checkInventory({ markdown, files, contents }) {
  const errors = [];
  const rows = parseInventory(markdown);
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.file)) errors.push(`${row.file}: listed more than once in docs/CI_WORKFLOWS.md`);
    seen.set(row.file, row);
    if (!CLASSIFICATIONS.has(row.classification)) {
      errors.push(`${row.file}: invalid classification "${row.classification}"`);
    }
    if (!row.owner) errors.push(`${row.file}: missing owner`);
    if (!row.authority) errors.push(`${row.file}: missing authority/purpose`);
    if (!files.includes(row.file)) errors.push(`${row.file}: listed in the inventory but does not exist`);
  }
  for (const file of files) {
    if (!seen.has(file)) errors.push(`${file}: not listed in docs/CI_WORKFLOWS.md`);
  }
  for (const file of files) {
    const content = contents[file] ?? '';
    if (!/^name:\s*\S/m.test(content)) errors.push(`${file}: missing top-level name`);
    if (!/^concurrency:/m.test(content)) errors.push(`${file}: missing top-level concurrency`);
    if (!/cancel-in-progress:/m.test(content)) errors.push(`${file}: concurrency must set cancel-in-progress`);
    if (seen.get(file)?.classification === 'Blocking gate' && !/pull_request:|push:/.test(content)) {
      errors.push(`${file}: classified as a blocking gate but has no pull_request or push trigger`);
    }
    if (seen.get(file)?.classification === 'Scheduled drill' && !/drill-outcome/.test(content)) {
      errors.push(`${file}: scheduled drill must record a drill-outcome issue`);
    }
  }
  return { errors, rows };
}

async function main() {
  const entries = await readdir(WORKFLOWS_DIR);
  const files = entries.filter((entry) => /\.ya?ml$/.test(entry)).sort();
  const contents = {};
  for (const file of files) {
    contents[file] = await readFile(path.join(WORKFLOWS_DIR, file), 'utf8');
  }
  const markdown = await readFile(INVENTORY, 'utf8');
  const { errors, rows } = checkInventory({ markdown, files, contents });
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(`\n${errors.length} workflow inventory error(s); see docs/CI_WORKFLOWS.md`);
    return 1;
  }
  console.log(`workflow inventory valid: ${rows.length} workflows classified and owned`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
