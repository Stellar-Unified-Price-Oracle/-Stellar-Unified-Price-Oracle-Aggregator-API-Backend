import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assignCohort,
  auditDigest,
  consumerCostChangePercent,
  decide,
  evaluateAll,
  evaluateRollback,
  renderReport,
  validateExperiment,
} from '../pricing-experiments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function load() {
  return JSON.parse(await readFile(path.join(root, 'config', 'pricing-experiments.json'), 'utf8'));
}

function base(policy, overrides = {}) {
  return { ...policy.experiments[0], ...overrides };
}

test('the registered experiment passes every safeguard', async () => {
  const policy = await load();
  const r = validateExperiment(policy, policy.experiments[0], policy.experiments);
  assert.deepEqual(r.violations, []);
  assert.equal(r.consumerCostChangePercent, -15);
  assert.equal(r.cohortKeys, 7);
});

test('cost change direction treats fewer included requests as an increase', () => {
  assert.equal(consumerCostChangePercent({ lever: 'baseFeeMonthlyUsd', controlValue: 100, treatmentValue: 110 }), 10);
  assert.equal(consumerCostChangePercent({ lever: 'includedMonthlyRequests', controlValue: 100000, treatmentValue: 90000 }), 10);
  assert.throws(() => consumerCostChangePercent({ id: 'x', lever: 'baseFeeMonthlyUsd', controlValue: 0, treatmentValue: 1 }), /controlValue/);
});

test('increase bound is inclusive at the limit and rejects above it', async () => {
  const policy = await load();
  const notice = { noticeSentAt: '2026-10-01', startDate: '2026-11-20', optIn: true };
  const atLimit = base(policy, { lever: 'baseFeeMonthlyUsd', controlValue: 100, treatmentValue: 115, ...notice });
  assert.equal(validateExperiment(policy, atLimit).valid, true);
  const over = base(policy, { lever: 'baseFeeMonthlyUsd', controlValue: 100, treatmentValue: 115.5, ...notice });
  assert.match(validateExperiment(policy, over).violations.join(), /exceeds 15%/);
});

test('increases require notice and, above the opt-in threshold, explicit consent', async () => {
  const policy = await load();
  const exp = base(policy, { lever: 'baseFeeMonthlyUsd', controlValue: 100, treatmentValue: 112, noticeSentAt: '2026-11-01', optIn: false });
  const v = validateExperiment(policy, exp).violations.join('\n');
  assert.match(v, /notice of 19 day\(s\) is below the required 30/);
  assert.match(v, /requires explicit opt-in/);
});

test('rejects ineligible tiers, disallowed levers and protected guarantees', async () => {
  const policy = await load();
  const v = validateExperiment(policy, base(policy, { tier: 'enterprise', lever: 'rateLimit', touchesGuarantees: ['sla'] })).violations.join('\n');
  assert.match(v, /tier "enterprise" is not eligible/);
  assert.match(v, /lever "rateLimit" is not allowed/);
  assert.match(v, /protected guarantees: sla/);
});

test('rejects undersized cohorts, missing holdout and out-of-range durations', async () => {
  const policy = await load();
  const v = validateExperiment(policy, base(policy, { eligibleKeys: 10, holdoutPercent: 0, endDate: '2026-11-25' })).violations.join('\n');
  assert.match(v, /below the minimum of 5/);
  assert.match(v, /holdoutPercent 0/);
  assert.match(v, /duration 5d/);
});

test('overlapping experiments in the same tier break isolation; other tiers do not', async () => {
  const policy = await load();
  const a = policy.experiments[0];
  const sameTier = { ...a, id: 'other', startDate: '2026-12-01', endDate: '2026-12-31' };
  const otherTier = { ...sameTier, id: 'free-one', tier: 'free' };
  assert.match(validateExperiment(policy, a, [a, sameTier]).violations.join(), /overlaps other/);
  assert.equal(validateExperiment(policy, a, [a, otherTier]).valid, true);
});

test('cohort assignment is deterministic, sticky and close to the configured split', () => {
  const exp = { salt: 's1', cohortPercent: 20, holdoutPercent: 10 };
  assert.equal(assignCohort('key-1', exp), assignCohort('key-1', exp));
  assert.equal(assignCohort('key-1', exp, { excluded: true }), 'excluded');
  const counts = { treatment: 0, holdout: 0, control: 0 };
  for (let i = 0; i < 20000; i += 1) counts[assignCohort(`k${i}`, exp)] += 1;
  assert.ok(Math.abs(counts.treatment / 20000 - 0.2) < 0.02);
  assert.ok(Math.abs(counts.holdout / 20000 - 0.1) < 0.02);
});

test('rollback triggers fire strictly beyond thresholds and report missing metrics', async () => {
  const policy = await load();
  const ok = { churnRateDeltaPp: 2.0, downgradeRateDeltaPp: 3.0, billingComplaintsPer100Keys: 3.0, revenueDeltaPercent: -10.0, optOutRatePercent: 20.0 };
  assert.equal(evaluateRollback(policy, ok).rollback, false);
  const bad = evaluateRollback(policy, { ...ok, revenueDeltaPercent: -10.1 });
  assert.deepEqual(bad.tripped.map((t) => t.metric), ['revenueDeltaPercent']);
  assert.deepEqual(evaluateRollback(policy, {}).missing.length, policy.rollbackTriggers.length);
});

test('decision precedence: rejected > rollback > insufficient evidence > continue', () => {
  const valid = { valid: true };
  assert.equal(decide({ valid: false }, { rollback: true, missing: [] }), 'REJECTED');
  assert.equal(decide(valid, { rollback: true, missing: ['x'] }), 'ROLLBACK');
  assert.equal(decide(valid, { rollback: false, missing: ['x'] }), 'INSUFFICIENT_EVIDENCE');
  assert.equal(decide(valid, { rollback: false, missing: [] }), 'CONTINUE');
});

test('audit digest changes when observations or design change', async () => {
  const policy = await load();
  const exp = policy.experiments[0];
  const d = auditDigest(policy, exp);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.notEqual(d, auditDigest(policy, { ...exp, observations: { ...exp.observations, churnRateDeltaPp: 9 } }));
  assert.notEqual(d, auditDigest(policy, { ...exp, treatmentValue: 0.16 }));
});

test('committed report matches the generator', async () => {
  const policy = await load();
  const rendered = renderReport(policy, evaluateAll(policy));
  const existing = await readFile(path.join(root, 'docs', 'PRICING_EXPERIMENT_SAFEGUARDS.md'), 'utf8');
  assert.equal(existing.trim(), rendered.trim());
  assert.match(rendered, /Decision: CONTINUE/);
});
