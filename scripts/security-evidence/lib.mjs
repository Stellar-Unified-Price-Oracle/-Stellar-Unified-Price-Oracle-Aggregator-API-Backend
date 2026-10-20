import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function runCheck(check, root, git = defaultGit) {
  const abs = path.resolve(root, check.path ?? '');
  if (check.path && !abs.startsWith(path.resolve(root) + path.sep)) {
    return { check, pass: false, detail: 'path escapes repository root' };
  }
  switch (check.type) {
    case 'file-exists':
      return fs.existsSync(abs)
        ? { check, pass: true, detail: 'present', sha256: sha256File(abs) }
        : { check, pass: false, detail: 'file not found' };
    case 'file-contains': {
      if (!fs.existsSync(abs)) return { check, pass: false, detail: 'file not found' };
      const ok = fs.readFileSync(abs, 'utf8').includes(check.text);
      return { check, pass: ok, detail: ok ? 'text found' : 'text not found', sha256: sha256File(abs) };
    }
    case 'git-history': {
      const last = git(['log', '-1', '--format=%H %cI', '--', check.path], root);
      return last ? { check, pass: true, detail: `last change ${last}` } : { check, pass: false, detail: 'no git history for path' };
    }
    default:
      return { check, pass: false, detail: `unknown check type "${check.type}"` };
  }
}

function defaultGit(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); } catch { return ''; }
}

export function collectEvidence({ controls, root, periodStart, periodEnd, now = new Date(), git = defaultGit, exceptions = [] }) {
  if (!(Date.parse(periodStart) <= Date.parse(periodEnd))) throw new Error('invalid collection period');
  const entries = controls.controls.map((c) => {
    const results = c.checks.map((k) => runCheck(k, root, git));
    const failed = results.filter((r) => !r.pass);
    const waived = exceptions.filter((e) => e.controlId === c.id);
    const status = failed.length === 0 ? 'pass' : waived.length ? 'excepted' : 'fail';
    return { id: c.id, title: c.title, owner: c.owner, frequency: c.frequency, status, results, exceptions: waived };
  });
  return {
    schema: 'security-evidence/v1',
    provenance: {
      generatedAt: now.toISOString(),
      generator: 'scripts/security-evidence/collect.mjs',
      gitCommit: git(['rev-parse', 'HEAD'], root) || 'unknown',
      controlsSha256: crypto.createHash('sha256').update(JSON.stringify(controls)).digest('hex'),
    },
    collectionPeriod: { start: periodStart, end: periodEnd },
    summary: { total: entries.length, pass: entries.filter((e) => e.status === 'pass').length, excepted: entries.filter((e) => e.status === 'excepted').length, fail: entries.filter((e) => e.status === 'fail').length },
    controls: entries,
    // Reviewer fills this in; collection never signs on anyone's behalf.
    signOff: { reviewer: null, reviewedAt: null, decision: null, notes: null },
  };
}

// Returns a list of problems; empty means the evidence is signed off and acceptable.
export function validateSignOff(evidence) {
  const problems = [];
  const s = evidence.signOff ?? {};
  if (!s.reviewer) problems.push('missing reviewer');
  if (!s.reviewedAt || Number.isNaN(Date.parse(s.reviewedAt))) problems.push('missing or invalid reviewedAt');
  if (!['approved', 'rejected'].includes(s.decision)) problems.push('decision must be approved or rejected');
  if (s.decision === 'approved' && evidence.summary.fail > 0) problems.push('cannot approve evidence with unexcepted failures');
  return problems;
}
