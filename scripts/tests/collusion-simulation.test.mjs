import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateRounds } from '../lib/oracle-economics.mjs';
import {
  buildRun,
  loadInputs,
  renderReport,
  runCollusionSimulation,
  shiftFor,
  validateScenarios,
  verdictFor,
} from '../collusion-simulation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('shift strategies resolve relative to the rule set breaker', () => {
  const policy = { circuitBreakerDeviationPct: 20 };
  assert.equal(shiftFor({ shift: { pct: 15 } }, policy), 1500);
  assert.equal(shiftFor({ shift: { breakerMultiple: 1.9 } }, policy), 3800);
  const drift = shiftFor({ shift: { driftBpsPerRound: 2, capBreakerMultiple: 1.9 } }, policy);
  assert.equal(drift(0), 2);
  assert.equal(drift(99), 200);
  assert.equal(drift(100000), 3800);
});

test('buildRun places colluders, DoS targets and sybils', async () => {
  const { params } = await loadInputs();
  const ruleSet = { id: 'x', policy: 'current', sourceSet: 'production' };
  const dos = buildRun({ id: 'd', colluders: 1, dosHonest: 2, shift: { pct: 1 } }, ruleSet, params);
  assert.deepEqual(dos.attackers, ['reflector']);
  assert.deepEqual(dos.forcedOffline, ['chainlink', 'redstone']);
  const sybil = buildRun({ id: 's', sybils: 2, shift: { pct: 1 } }, ruleSet, params);
  assert.equal(sybil.sources.length, 6);
  assert.equal(sybil.stakedAttackers, 2);
  assert.equal(sybil.issuers['sybil-1'], sybil.issuers['sybil-2']);
  assert.throws(() => buildRun({ id: 'big', colluders: 9, shift: { pct: 1 } }, ruleSet, params), /needs 9 colluders/);
});

test('verdict classification covers all four outcomes', async () => {
  const { params } = await loadInputs();
  const clean = { corruptionRate: 0, availability: 1, meanCorruptErrorBps: 0 };
  assert.equal(verdictFor({ run: clean, staked: 1, params }).verdict, 'resisted');
  assert.equal(verdictFor({ run: { ...clean, availability: 0.5 }, staked: 1, params }).verdict, 'halted');
  const corrupt = { corruptionRate: 1, availability: 1, meanCorruptErrorBps: 101 };
  assert.equal(verdictFor({ run: corrupt, staked: 100, params }).verdict, 'deterred');
  const bad = verdictFor({ run: { ...corrupt, meanCorruptErrorBps: 2000 }, staked: 1, params });
  assert.equal(bad.verdict, 'vulnerable');
  assert.ok(bad.stakeToDeterUsd > params.incentives.stakePerSourceUsd);
});

test('corruption exactly at the budget boundary is not counted as corrupted', async () => {
  const { params } = await loadInputs();
  const atBudget = { corruptionRate: params.slo.corruptionBudgetPct / 100, availability: 1, meanCorruptErrorBps: 500 };
  assert.equal(verdictFor({ run: atBudget, staked: 1, params }).verdict, 'resisted');
});

test('warm-up rounds keep attackers honest and DoS targets live', () => {
  const run = simulateRounds({
    rounds: 50, seed: 3, sources: ['a', 'b', 'c', 'd'], referencePrice: 1, honestNoiseBps: 5, volatilityBps: 1,
    maxTolerableErrorBps: 100, policy: { minSources: 3, circuitBreakerDeviationPct: 2 },
    attackers: ['d'], attackShiftBps: 5000, forcedOffline: ['a', 'b'], attackStartRound: 50,
  });
  assert.equal(run.availability, 1);
  assert.equal(run.corruptionRate, 0);
});

test('validateScenarios rejects broken definitions', async () => {
  const { scenarios, params } = await loadInputs();
  assert.doesNotThrow(() => validateScenarios(scenarios, params));
  assert.throws(() => validateScenarios({ ...scenarios, ruleSets: [...scenarios.ruleSets, scenarios.ruleSets[0]] }, params), /duplicate rule set/);
  assert.throws(() => validateScenarios({ ...scenarios, ruleSets: [{ id: 'z', policy: 'nope', sourceSet: 'production' }] }, params), /unknown policy/);
  assert.throws(() => validateScenarios({ ...scenarios, attacks: [{ id: 'none', shift: { pct: 1 } }] }, params), /colluder or sybil/);
  assert.throws(() => validateScenarios({ ...scenarios, attacks: [{ id: 'flat', colluders: 1, shift: {} }] }, params), /positive shift/);
});

test('simulated verdicts match the pinned expectations', async () => {
  const { scenarios, params } = await loadInputs();
  const result = runCollusionSimulation(scenarios, params);
  assert.deepEqual(result.mismatches, [], 'update expectedVerdicts only for an intended rule change');
  assert.equal(result.cells.length, scenarios.attacks.length * scenarios.ruleSets.length);
});

test('current rules only resist an isolated bad source; hardening closes specific attacks', async () => {
  const { scenarios, params } = await loadInputs();
  const { cells } = runCollusionSimulation(scenarios, params);
  const v = (attack, ruleSet) => cells.find((c) => c.attack === attack && c.ruleSet === ruleSet).verdict;
  assert.deepEqual(cells.filter((c) => c.ruleSet === 'current' && c.verdict === 'resisted').map((c) => c.attack), ['single-outlier']);
  assert.equal(v('dos-plus-one', 'recommended'), 'halted');
  assert.equal(v('sybil-flood', 'recommended'), 'resisted');
  assert.equal(v('breaker-evasion-pair', 'recommended-5'), 'resisted');
  assert.equal(v('slow-drift', 'current-guarded'), 'vulnerable');
  assert.equal(v('majority-cartel', 'recommended-5'), 'vulnerable');
});

test('generated report is up to date and documents rollout and rollback', async () => {
  const { scenarios, params } = await loadInputs();
  const rendered = renderReport(runCollusionSimulation(scenarios, params));
  const committed = await readFile(path.join(root, 'docs', 'COLLUSION_RESISTANCE_REPORT.md'), 'utf8');
  assert.equal(committed.trim(), rendered.trim(), 'run: npm run economics:collusion');
  for (const heading of ['## Verdict matrix', '## Repeatable review procedure', '## Compatibility, monitoring and operational impact', '## Rollout and rollback']) {
    assert.ok(rendered.includes(heading), heading);
  }
});
