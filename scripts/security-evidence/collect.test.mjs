import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectEvidence, validateSignOff, runCheck } from './lib.mjs';

const fakeGit = (args) => (args[0] === 'rev-parse' ? 'abc123' : args[0] === 'log' && args.includes('tracked.txt') ? 'abc123 2024-01-01T00:00:00Z' : '');
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evid-'));
  fs.writeFileSync(path.join(d, 'tracked.txt'), 'hello policy');
  return d;
};
const controls = { controls: [
  { id: 'A', title: 'a', owner: 'o', frequency: 'q', checks: [{ type: 'file-exists', path: 'tracked.txt' }, { type: 'git-history', path: 'tracked.txt' }] },
  { id: 'B', title: 'b', owner: 'o', frequency: 'q', checks: [{ type: 'file-contains', path: 'tracked.txt', text: 'missing' }] },
] };
const base = { controls, periodStart: '2024-01-01', periodEnd: '2024-03-31', git: fakeGit, now: new Date('2024-04-01T00:00:00Z') };

test('collects pass/fail with provenance and empty sign-off', () => {
  const ev = collectEvidence({ ...base, root: mk() });
  assert.equal(ev.provenance.gitCommit, 'abc123');
  assert.deepEqual(ev.summary, { total: 2, pass: 1, excepted: 0, fail: 1 });
  assert.equal(ev.signOff.reviewer, null);
});

test('exceptions mark failing control as excepted', () => {
  const ev = collectEvidence({ ...base, root: mk(), exceptions: [{ controlId: 'B', reason: 'waived', approvedBy: 'x' }] });
  assert.equal(ev.summary.fail, 0);
  assert.equal(ev.controls[1].status, 'excepted');
});

test('boundary: invalid period and path traversal rejected', () => {
  assert.throws(() => collectEvidence({ ...base, root: mk(), periodStart: '2024-05-01' }));
  assert.equal(runCheck({ type: 'file-exists', path: '../etc/passwd' }, mk()).pass, false);
  assert.equal(runCheck({ type: 'bogus', path: 'x' }, mk()).pass, false);
});

test('sign-off validation', () => {
  const ev = collectEvidence({ ...base, root: mk() });
  assert.ok(validateSignOff(ev).length >= 3);
  ev.signOff = { reviewer: 'r', reviewedAt: '2024-04-02T00:00:00Z', decision: 'approved' };
  assert.deepEqual(validateSignOff(ev), ['cannot approve evidence with unexcepted failures']);
  ev.signOff.decision = 'rejected';
  assert.deepEqual(validateSignOff(ev), []);
});
