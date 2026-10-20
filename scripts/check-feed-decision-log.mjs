#!/usr/bin/env node
// Validates records in docs/governance/feed-onboarding-decisions (no dependencies).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'docs/governance/feed-onboarding-decisions';
const STATUSES = new Set(['proposed', 'accepted', 'rejected', 'deferred', 'suspended', 'removed']);
const SECTIONS = ['Evidence reviewed', 'Conflicts of interest', 'Rationale', 'Approvers', 'Rollout / rollback', 'Review outcomes'];
const field = (t, n) => (t.match(new RegExp(`^- ${n}:\\s*(.+)$`, 'm')) || [])[1]?.trim();

const errors = [];
const warnings = [];
const ids = new Set();
const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f));

for (const f of files) {
  const t = readFileSync(join(dir, f), 'utf8');
  const err = (m) => errors.push(`${f}: ${m}`);
  const id = field(t, 'Decision ID');
  const proposer = field(t, 'Proposer');
  const status = field(t, 'Status');
  const review = field(t, 'Review date');
  if (!id || !/^FOD-\d{4}-\d{3}$/.test(id)) err('missing or malformed Decision ID');
  else if (ids.has(id)) err(`duplicate Decision ID ${id}`);
  else ids.add(id);
  if (!field(t, 'Feed')) err('missing Feed');
  if (!proposer) err('missing Proposer');
  if (!status || !STATUSES.has(status)) err('missing or unknown Status');
  for (const s of SECTIONS) if (!new RegExp(`^## ${s}\\s*$`, 'm').test(t)) err(`missing section "${s}"`);
  const approvers = new Set(
    [...(t.match(/^## Approvers\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || '').matchAll(/^- (\S+)/gm)].map((m) => m[1]),
  );
  if (status === 'accepted') {
    approvers.delete(proposer);
    if (approvers.size < 2) err('accepted records need >= 2 distinct non-proposer approvers');
  }
  if (!review || Number.isNaN(Date.parse(review))) err('missing or invalid Review date');
  else if (Date.parse(review) < Date.now() && status === 'accepted' && /\(none yet\)/.test(t)) {
    warnings.push(`${f}: review date ${review} passed with no review outcome`);
  }
}

for (const w of warnings) console.warn(`WARN ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`checked ${files.length} record(s): ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
