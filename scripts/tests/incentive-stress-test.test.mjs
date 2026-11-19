import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateRound,
  contractGuardAccepts,
  createRng,
  hhi,
  median,
  simulateRounds,
} from '../lib/oracle-economics.mjs';
import {
  attackEconomics,
  gasSurgeMultiplier,
  manipulationCost,
  operatorEquilibrium,
  renderReport,
  runIncentiveStressTest,
  validateConfig,
} from '../incentive-stress-test.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = async (rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));
const loadConfig = () => load('config/incentive-stress-test.json');
const loadSustainability = () => load('config/sustainability-model.json');

const current = { minSources: 1, circuitBreakerDeviationPct: 20, fallbackToSuspicious: true };
const strict = { minSources: 3, circuitBreakerDeviationPct: 2, fallbackToSuspicious: false };

test('rng is deterministic per seed', () => {
  const a = createRng(7);
  const b = createRng(7);
  assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
  assert.notEqual(createRng(8).next(), createRng(7).next());
});

test('median handles odd, even and empty inputs', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), /empty/);
});

test('aggregateRound excludes a lone outlier and publishes the honest median', () => {
  const r = aggregateRound(
    [{ source: 'a', price: 100 }, { source: 'b', price: 101 }, { source: 'c', price: 99 }, { source: 'd', price: 200 }],
    current,
  );
  assert.equal(r.published, true);
  assert.deepEqual(r.flagged, ['d']);
  assert.equal(r.price, 100);
});

test('aggregateRound mirrors the legacy suspicious fallback when every report is flagged', () => {
  const reports = [{ source: 'a', price: 100 }, { source: 'b', price: 100 }, { source: 'c', price: 160 }, { source: 'd', price: 160 }];
  const legacy = aggregateRound(reports, current);
  assert.equal(legacy.reason, 'suspicious-fallback');
  assert.equal(legacy.price, 130);
  const hardened = aggregateRound(reports, strict);
  assert.equal(hardened.published, false);
});

test('aggregateRound enforces quorum and distinct issuers', () => {
  const offline = aggregateRound([{ source: 'a', price: 1 }, { source: 'b', price: null }, { source: 'c', price: null }], strict);
  assert.equal(offline.published, false);
  assert.equal(offline.reason, 'quorum');
  assert.deepEqual(offline.offline, ['b', 'c']);
  const sybil = aggregateRound(
    [{ source: 'a', issuer: 'x', price: 1 }, { source: 'b', issuer: 'x', price: 1 }, { source: 'c', issuer: 'y', price: 1 }],
    { ...strict, distinctIssuersOnly: true },
  );
  assert.equal(sybil.published, false);
  assert.throws(() => aggregateRound([], { minSources: 0, circuitBreakerDeviationPct: 1 }), /minSources/);
});

test('contract guard compares with the last accepted price and is inert when unset', () => {
  assert.equal(contractGuardAccepts(100.4, 100, 50), true);
  assert.equal(contractGuardAccepts(100.6, 100, 50), false);
  assert.equal(contractGuardAccepts(500, 100, null), true);
  assert.equal(contractGuardAccepts(500, null, 50), true);
});

test('hhi spans unconcentrated to monopoly and rejects bad input', () => {
  assert.equal(hhi([1, 1, 1, 1]), 2500);
  assert.equal(hhi([1]), 10000);
  assert.throws(() => hhi([0, 0]), /positive/);
  assert.throws(() => hhi([2, -1]), /non-negative/);
});

test('simulateRounds is honest and fully available with no stress', () => {
  const run = simulateRounds({
    rounds: 500, seed: 1, sources: ['a', 'b', 'c', 'd'], policy: strict, referencePrice: 1,
    honestNoiseBps: 5, volatilityBps: 5, maxTolerableErrorBps: 100,
  });
  assert.equal(run.availability, 1);
  assert.equal(run.corruptionRate, 0);
  assert.ok(run.p99ErrorBps < 20);
  assert.throws(() => simulateRounds({ rounds: 10, seed: 1, sources: ['a'], policy: strict, referencePrice: 1, attackers: ['z'] }), /not a configured source/);
});

test('validateConfig accepts the shipped config and rejects broken ones', async () => {
  const config = await loadConfig();
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, owner: '' }), /owner is required/);
  assert.throws(() => validateConfig({ ...config, sources: ['a', 'b'] }), /three sources/);
  assert.throws(
    () => validateConfig({ ...config, incentives: { ...config.incentives, slashFractionPerIncident: 1.5 } }),
    /slashFractionPerIncident/,
  );
});

test('attack economics computes the stake needed to deter a coalition', async () => {
  const config = await loadConfig();
  const e = attackEconomics(config, 2, 200);
  assert.equal(e.profitUsd, 20000);
  assert.equal(e.expectedPenaltyUsd, 2 * 5000 * 0.5 * 0.9);
  assert.ok(Math.abs(e.minStakeToDeterUsd - 20000 / 0.9) < 1e-6);
  assert.equal(e.deterred, false);
  assert.equal(attackEconomics(config, 0, 0).deterred, true);
});

test('manipulation cost drops sharply once venues consolidate', async () => {
  const config = await loadConfig();
  assert.equal(manipulationCost(config, 1).venues, 3);
  assert.equal(manipulationCost(config, 0.1).venues, 1);
  assert.equal(manipulationCost(config, 1).resistant, true);
  assert.equal(manipulationCost(config, 0.01).resistant, false);
});

test('gas surge interpolates and clamps', () => {
  const points = [[1, 1], [2, 5], [5, 50]];
  assert.equal(gasSurgeMultiplier(points, 0.2), 1);
  assert.equal(gasSurgeMultiplier(points, 1.5), 3);
  assert.equal(gasSurgeMultiplier(points, 50), 50);
});

test('operator equilibrium drops the most expensive operator first', async () => {
  const config = await loadConfig();
  const eq = operatorEquilibrium(config, 300, 0);
  assert.ok(!eq.active.includes('reflector'));
  assert.ok(eq.active.includes('chainlink'));
  assert.equal(operatorEquilibrium(config, 0, 0).active.length, 0);
});

test('full stress test finds the documented failure thresholds', async () => {
  const result = runIncentiveStressTest(await loadConfig(), await loadSustainability());
  assert.equal(result.baselineHealthy, true);

  const [currentSet, recommendedSet, expandedSet] = result.collusion;
  assert.equal(currentSet.threshold, 2);
  assert.equal(recommendedSet.threshold, 2);
  assert.equal(expandedSet.threshold, 3);
  assert.ok(recommendedSet.rows[2].meanCorruptErrorBps < currentSet.rows[2].meanCorruptErrorBps);
  assert.equal(currentSet.rows[1].corrupts, false);

  assert.ok(result.lowLiquidity.thresholds.manipulation !== null);
  assert.ok(result.lowLiquidity.thresholds.guardLockout > result.lowLiquidity.thresholds.manipulation);
  assert.ok(result.correlatedOutage.thresholds.recommendedAvailability !== null);
  assert.equal(result.correlatedOutage.thresholds.currentAvailability, null);
  const worstOutage = result.correlatedOutage.rows.at(-1);
  assert.ok(worstOutage.exemptPenaltyUsd < worstOutage.naivePenaltyUsd);
  assert.ok(result.demandShock.thresholds.demandSurgeQuorum !== null);
});

test('generated report is up to date and documents rollout and rollback', async () => {
  const rendered = renderReport(runIncentiveStressTest(await loadConfig(), await loadSustainability()));
  const committed = await readFile(path.join(root, 'docs', 'INCENTIVE_STRESS_TEST.md'), 'utf8');
  assert.equal(committed.trim(), rendered.trim(), 'run: npm run economics:stress');
  for (const heading of ['## Failure thresholds at a glance', '## Owner, scope and limitations', '## Compatibility, monitoring and operational impact', '## Rollout and rollback']) {
    assert.ok(rendered.includes(heading), heading);
  }
});
