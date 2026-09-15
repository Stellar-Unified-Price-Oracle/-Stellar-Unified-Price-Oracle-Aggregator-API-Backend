import { readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];

const dir = path.dirname(new URL(import.meta.url).pathname);

function parse(file) {
  const text = readFileSync(path.join(dir, file), 'utf8');
  const issues = [];
  let current = null;
  let bodyLines = [];
  // @@TARGET may appear before @@TITLE, so hold it until a record is open.
  let pendingTarget = null;

  const flush = () => {
    if (!current) return;
    current.body = bodyLines.join('\n').trim();
    issues.push(current);
    current = null;
    bodyLines = [];
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('@@TITLE:')) {
      flush();
      current = {
        title: line.slice('@@TITLE:'.length).trim(),
        labels: [],
        target: pendingTarget,
        body: '',
      };
      pendingTarget = null;
    } else if (line.startsWith('@@LABELS:')) {
      if (current) {
        current.labels = line.slice('@@LABELS:'.length).split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (line.startsWith('@@TARGET:')) {
      const n = Number(line.slice('@@TARGET:'.length).trim());
      if (current) current.target = n;
      else pendingTarget = n;
    } else if (line.startsWith('@@BODY')) {
      // structural marker only — never content
    } else if (line.startsWith('@@END')) {
      flush();
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();
  return issues;
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.md') && f.match(/^\d\d-/))
  .sort();

const all = files.flatMap(parse);

if (all.length === 0) {
  console.error('No issues parsed — check the @@TITLE/@@END delimiters.');
  process.exit(1);
}

// Validate before doing anything against GitHub.
let bad = 0;
for (const issue of all) {
  const problems = [];
  if (!issue.title) problems.push('missing title');
  if (issue.title.length > 250) problems.push(`title too long (${issue.title.length})`);
  if (!issue.body) problems.push('missing body');
  if (issue.labels.length === 0) problems.push('no labels');
  if (/@@|^###\s/i.test(issue.title)) problems.push('title contains delimiter artifact');
  if (/@@/.test(issue.body)) problems.push('body contains a stray @@ delimiter');
  if (issue.target !== null && !Number.isInteger(issue.target)) {
    problems.push(`invalid @@TARGET ${issue.target}`);
  }
  if (problems.length) {
    bad++;
    console.error(`INVALID: "${issue.title}" -> ${problems.join(', ')}`);
  }
}
if (bad) {
  console.error(`\n${bad} invalid issue(s). Aborting.`);
  process.exit(1);
}

const edits = all.filter((i) => i.target);
const creates = all.filter((i) => !i.target);

console.log(`Parsed ${all.length} issues: ${creates.length} to create, ${edits.length} to rewrite.`);
for (const f of files) console.log(`  ${f}: ${parse(f).length}`);

if (DRY_RUN) {
  console.log('\n--- DRY RUN ---');
  for (const i of all) {
    const verb = i.target ? `EDIT #${i.target}` : 'CREATE';
    console.log(`${verb.padEnd(12)} [${i.labels.join(', ')}] ${i.title}`);
  }
  process.exit(0);
}

if (ONLY && !files.includes(ONLY)) {
  console.error(`--only=${ONLY} does not match any draft file`);
  process.exit(1);
}

const targets = ONLY ? parse(ONLY) : all;

// GitHub returns transient GraphQL/5xx errors under bursty write volume; retry those.
const RETRYABLE = /GraphQL:|502|503|504|ECONNRESET|ETIMEDOUT|socket hang up/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attempt(issue) {
  if (issue.target) {
    const args = ['issue', 'edit', String(issue.target), '--title', issue.title, '--body', issue.body];
    for (const l of issue.labels) args.push('--add-label', l);
    execFileSync('gh', args, { stdio: 'pipe' });
    return `UPDATED #${issue.target}  ${issue.title}`;
  }
  const args = ['issue', 'create', '--title', issue.title, '--body', issue.body];
  for (const l of issue.labels) args.push('--label', l);
  const out = execFileSync('gh', args, { stdio: 'pipe', encoding: 'utf8' });
  return `CREATED     ${out.trim()}`;
}

let ok = 0;
let failed = 0;
const failures = [];

for (const issue of targets) {
  let lastErr = null;
  let succeeded = false;

  for (let n = 1; n <= 5 && !succeeded; n++) {
    try {
      console.log(attempt(issue));
      succeeded = true;
      ok++;
    } catch (err) {
      lastErr = err;
      const raw = (err.stderr || err.message || '').toString();
      if (n < 5 && RETRYABLE.test(raw)) {
        const wait = 2000 * n;
        console.error(`  retry ${n}/4 in ${wait}ms — ${issue.title}`);
        await sleep(wait);
      } else {
        break;
      }
    }
  }

  if (!succeeded) {
    failed++;
    failures.push(issue);
    const msg = (lastErr.stderr || lastErr.message || '').toString().trim().split('\n').slice(-3).join(' | ');
    console.error(`FAILED      ${issue.title}\n            ${msg}`);
  }

  await sleep(600);
}

if (failures.length) {
  console.error(`\nStill failing (re-run to retry): ${failures.map((f) => f.target ?? f.title).join(', ')}`);
}
console.log(`\nDone. ${ok} succeeded, ${failed} failed.`);
process.exit(failed ? 1 : 0);
