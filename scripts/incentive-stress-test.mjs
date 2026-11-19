#!/usr/bin/env node

/**
 * scripts/incentive-stress-test.mjs — issue #788
 *
 * Simulates provider and participant incentives under low liquidity, collusion,
 * correlated outages and demand shocks, and records the failure threshold of
 * each stress dimension. Generates and validates docs/INCENTIVE_STRESS_TEST.md.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { calculateRevenue } from './sustainability-model.mjs';
import { firstFailure, money, pct, round, simulateRounds } from './lib/oracle-economics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'incentive-stress-test.json');
const sustainabilityPath = path.join(root, 'config', 'sustainability-model.json');
const reportPath = path.join(root, 'docs', 'INCENTIVE_STRESS_TEST.md');

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') throw new Error('stress-test config must be an object');
  if (!config.owner) errors.push('owner is required');
  if (!Array.isArray(config.sources) || config.sources.length < 3) errors.push('at least three sources are required');
  if (!Number.isInteger(config.roundsPerRun) || config.roundsPerRun < 100) errors.push('roundsPerRun must be an integer >= 100');
  for (const name of ['current', 'recommended']) {
    if (!config.policies?.[name]) errors.push(`policies.${name} is required`);
  }
  const inc = config.incentives ?? {};
  if (!(inc.slashFractionPerIncident > 0 && inc.slashFractionPerIncident <= 1)) errors.push('slashFractionPerIncident must be in (0, 1]');
  if (!(inc.detectionProbability > 0 && inc.detectionProbability <= 1)) errors.push('detectionProbability must be in (0, 1]');
  for (const s of config.sources ?? []) {
    if (!(inc.operatorFixedMonthlyCostUsd?.[s] >= 0)) errors.push(`operatorFixedMonthlyCostUsd.${s} is required`);
  }
  if (!(config.market?.referencePriceUsd > 0)) errors.push('market.referencePriceUsd must be positive');
  if (errors.length) throw new Error(`Invalid incentive stress-test config:\n- ${errors.join('\n- ')}`);
  return config;
}

function baseRun(config, overrides) {
  const m = config.market;
  return simulateRounds({
    rounds: config.roundsPerRun,
    seed: config.seed,
    sources: config.sources,
    referencePrice: m.referencePriceUsd,
    honestNoiseBps: m.honestNoiseBps,
    volatilityBps: m.volatilityBpsPerRound,
    maxTolerableErrorBps: m.maxTolerableErrorBps,
    policy: config.policies.current,
    ...overrides,
  });
}

export function attackEconomics(config, colluders, meanCorruptErrorBps) {
  const { market: m, incentives: inc } = config;
  const profitUsd = m.protocolTvlUsd * m.extractableFractionOfError * (meanCorruptErrorBps / 10_000);
  if (colluders === 0 || profitUsd === 0) {
    return { profitUsd, expectedPenaltyUsd: 0, minStakeToDeterUsd: 0, deterred: true };
  }
  const expectedPenaltyUsd = colluders * inc.stakePerSourceUsd * inc.slashFractionPerIncident * inc.detectionProbability;
  const minStakeToDeterUsd = profitUsd / (colluders * inc.slashFractionPerIncident * inc.detectionProbability);
  return { profitUsd, expectedPenaltyUsd, minStakeToDeterUsd, deterred: expectedPenaltyUsd >= profitUsd };
}

export function manipulationCost(config, liquidityFactor, sourceCount = config.sources.length) {
  const m = config.market;
  const venues = liquidityFactor >= m.venueConsolidationBelowLiquidity ? Math.floor(sourceCount / 2) + 1 : 1;
  const errorPct = m.maxTolerableErrorBps / 100;
  const costUsd = m.referenceVenueDepthUsdPer1Pct * liquidityFactor * errorPct * venues;
  const profitUsd = m.protocolTvlUsd * m.extractableFractionOfError * (m.maxTolerableErrorBps / 10_000);
  return { venues, costUsd, profitUsd, resistant: costUsd >= profitUsd };
}

export function runLowLiquidity(config) {
  const sc = config.scenarios.lowLiquidity;
  const { slo } = config;
  const rows = sc.liquidityFactors.map((L) => {
    const scale = 1 / Math.sqrt(L);
    const shared = { honestNoiseBps: config.market.honestNoiseBps * scale, volatilityBps: config.market.volatilityBpsPerRound * scale };
    const guarded = baseRun(config, { ...shared, guardBps: sc.contractDeviationGuardBps });
    const recommended = baseRun(config, { ...shared, policy: config.policies.recommended });
    const manip = manipulationCost(config, L);
    return {
      liquidityFactor: L,
      honestNoiseBps: round(shared.honestNoiseBps, 1),
      volatilityBps: round(shared.volatilityBps, 1),
      guardedAvailability: guarded.availability,
      guardedMaxLockoutRounds: guarded.maxConsecutiveUnavailable,
      recommendedHonestFlagRate: recommended.honestFlagRate,
      recommendedAvailability: recommended.availability,
      ...manip,
    };
  });
  return {
    rows,
    thresholds: {
      manipulation: firstFailure(rows, (r) => !r.resistant)?.liquidityFactor ?? null,
      guardLockout: firstFailure(rows, (r) => r.guardedAvailability * 100 < slo.availabilityPct)?.liquidityFactor ?? null,
      honestFalsePositives: firstFailure(rows, (r) => r.recommendedHonestFlagRate * 100 > slo.honestFlagBudgetPct)?.liquidityFactor ?? null,
    },
  };
}

function bestAttack(config, sources, policy, colluders) {
  const attackers = sources.slice(sources.length - colluders);
  let best = null;
  for (const shiftPct of config.scenarios.collusion.attackShiftsPct) {
    const run = baseRun(config, { sources, policy, attackers, attackShiftBps: shiftPct * 100 });
    const score = run.corruptionRate * run.meanCorruptErrorBps;
    if (!best || score > best.score) best = { shiftPct, run, score };
    if (colluders === 0) break;
  }
  return best;
}

export function runCollusion(config) {
  const sets = [
    { label: 'current rules, 4 sources', sources: config.sources, policy: config.policies.current },
    { label: 'recommended rules, 4 sources', sources: config.sources, policy: config.policies.recommended },
    { label: 'recommended rules, 5 sources', sources: config.scenarios.collusion.expandedSourceSet, policy: config.policies.recommended },
  ];
  const budget = config.slo.corruptionBudgetPct / 100;
  return sets.map((set) => {
    const rows = [];
    for (let k = 0; k <= set.sources.length; k++) {
      const { shiftPct, run } = bestAttack(config, set.sources, set.policy, k);
      rows.push({
        colluders: k,
        shiftPct: k === 0 ? 0 : shiftPct,
        corruptionRate: run.corruptionRate,
        availability: run.availability,
        meanCorruptErrorBps: run.meanCorruptErrorBps,
        corrupts: run.corruptionRate > budget,
        ...attackEconomics(config, k, run.meanCorruptErrorBps),
      });
    }
    return { ...set, rows, threshold: firstFailure(rows, (r) => r.corrupts)?.colluders ?? null };
  });
}

export function baselineRewardPerOperatorUsd(config, sustainabilityModel, activeOperators = config.sources.length, demand = 1) {
  const revenue = calculateRevenue(sustainabilityModel, demand).totalMonthlyRevenueUsd;
  return (revenue * config.incentives.rewardShareOfRevenue) / activeOperators;
}

export function runCorrelatedOutage(config, sustainabilityModel) {
  const sc = config.scenarios.correlatedOutage;
  const inc = config.incentives;
  const member = sc.dependencyGroups[sc.sharedGroup][0];
  const reward = baselineRewardPerOperatorUsd(config, sustainabilityModel);
  const gas = inc.submissionsPerOperatorMonthly * inc.gasPerSubmissionXlm * inc.xlmUsd;
  const rows = sc.groupOutageProbabilities.map((p) => {
    const outage = { groups: sc.dependencyGroups, groupProbability: p, independentProbability: sc.independentOutageProbability };
    const current = baseRun(config, { outage });
    const recommended = baseRun(config, { outage, policy: config.policies.recommended });
    const naivePenalty = recommended.missRate[member] * inc.roundsPerMonth * inc.livenessPenaltyUsdPerMissedRound;
    const exemptPenalty = recommended.soloMissRate[member] * inc.roundsPerMonth * inc.livenessPenaltyUsdPerMissedRound;
    const base = reward - inc.operatorFixedMonthlyCostUsd[member] - gas;
    return {
      groupOutageProbability: p,
      currentAvailability: current.availability,
      recommendedAvailability: recommended.availability,
      jointMissRate: recommended.jointMissRate,
      naivePenaltyUsd: naivePenalty,
      exemptPenaltyUsd: exemptPenalty,
      naiveMarginUsd: base - naivePenalty,
      exemptMarginUsd: base - exemptPenalty,
    };
  });
  const slo = config.slo.availabilityPct;
  return {
    member,
    rows,
    thresholds: {
      recommendedAvailability: firstFailure(rows, (r) => r.recommendedAvailability * 100 < slo)?.groupOutageProbability ?? null,
      currentAvailability: firstFailure(rows, (r) => r.currentAvailability * 100 < slo)?.groupOutageProbability ?? null,
      naiveOperatorExit: firstFailure(rows, (r) => r.naiveMarginUsd < 0)?.groupOutageProbability ?? null,
      exemptOperatorExit: firstFailure(rows, (r) => r.exemptMarginUsd < 0)?.groupOutageProbability ?? null,
    },
  };
}

export function gasSurgeMultiplier(points, demand) {
  if (demand <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [d0, g0] = points[i - 1];
    const [d1, g1] = points[i];
    if (demand <= d1) return g0 + ((g1 - g0) * (demand - d0)) / (d1 - d0);
  }
  return points[points.length - 1][1];
}

export function operatorEquilibrium(config, rewardPoolUsd, gasPerOperatorUsd) {
  let active = [...config.sources];
  for (;;) {
    const perOperator = active.length ? rewardPoolUsd / active.length : 0;
    const margins = active.map((s) => ({ s, margin: perOperator - config.incentives.operatorFixedMonthlyCostUsd[s] - gasPerOperatorUsd }));
    const losing = margins.filter((m) => m.margin < 0).sort((a, b) => a.margin - b.margin);
    if (losing.length === 0) return { active, perOperatorRewardUsd: perOperator, margins };
    active = active.filter((s) => s !== losing[0].s);
  }
}

export function runDemandShock(config, sustainabilityModel) {
  const sc = config.scenarios.demandShock;
  const inc = config.incentives;
  const minSources = config.policies.recommended.minSources;
  const rows = sc.demandMultipliers.map((d) => {
    const revenueUsd = calculateRevenue(sustainabilityModel, d).totalMonthlyRevenueUsd;
    const rewardPoolUsd = revenueUsd * inc.rewardShareOfRevenue;
    const gasMultiplier = gasSurgeMultiplier(sc.gasSurgeAtDemand, d);
    const gasPerOperatorUsd = inc.submissionsPerOperatorMonthly * inc.gasPerSubmissionXlm * inc.xlmUsd * gasMultiplier;
    const eq = operatorEquilibrium(config, rewardPoolUsd, gasPerOperatorUsd);
    return {
      demandMultiplier: d,
      revenueUsd,
      rewardPoolUsd,
      gasMultiplier,
      gasPerOperatorUsd,
      activeOperators: eq.active.length,
      quorumHolds: eq.active.length >= minSources,
    };
  });
  const below = rows.filter((r) => r.demandMultiplier < 1).reverse();
  const above = rows.filter((r) => r.demandMultiplier > 1);
  return {
    rows,
    thresholds: {
      demandCollapse: firstFailure(below, (r) => r.activeOperators < config.sources.length)?.demandMultiplier ?? null,
      demandCollapseQuorum: firstFailure(below, (r) => !r.quorumHolds)?.demandMultiplier ?? null,
      demandSurge: firstFailure(above, (r) => r.activeOperators < config.sources.length)?.demandMultiplier ?? null,
      demandSurgeQuorum: firstFailure(above, (r) => !r.quorumHolds)?.demandMultiplier ?? null,
    },
  };
}

export function runIncentiveStressTest(config, sustainabilityModel) {
  validateConfig(config);
  if (!sustainabilityModel) throw new Error('sustainability model is required for revenue figures');
  const lowLiquidity = runLowLiquidity(config);
  const collusion = runCollusion(config);
  const correlatedOutage = runCorrelatedOutage(config, sustainabilityModel);
  const demandShock = runDemandShock(config, sustainabilityModel);
  const baseline = {
    liquidity: lowLiquidity.rows.find((r) => r.liquidityFactor === 1),
    honestCollusionRow: collusion[0].rows[0],
    outage: correlatedOutage.rows.find((r) => r.groupOutageProbability === 0),
    demand: demandShock.rows.find((r) => r.demandMultiplier === 1),
  };
  const baselineHealthy = Boolean(
    baseline.liquidity?.resistant &&
      baseline.liquidity.guardedAvailability * 100 >= config.slo.availabilityPct &&
      !baseline.honestCollusionRow.corrupts &&
      baseline.outage?.recommendedAvailability * 100 >= config.slo.availabilityPct &&
      baseline.demand?.activeOperators === config.sources.length,
  );
  return { config, lowLiquidity, collusion, correlatedOutage, demandShock, baselineHealthy };
}

const threshold = (value, render = (v) => String(v)) => (value === null ? 'not reached in sweep' : render(value));

export function renderReport(result) {
  const { config, lowLiquidity: ll, collusion, correlatedOutage: co, demandShock: ds } = result;
  const slo = config.slo;
  const collusionTables = collusion
    .map(
      (set) => `#### ${set.label} (policy: minSources ${set.policy.minSources}, circuit breaker ${set.policy.circuitBreakerDeviationPct}%)

| Colluders | Best shift | Corrupted rounds | Availability | Mean error when corrupted | Attack profit | Expected penalty | Stake needed to deter | Deterred at ${money(config.incentives.stakePerSourceUsd)} stake |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
${set.rows
  .map((r) => `| ${r.colluders} | ${r.shiftPct}% | ${pct(r.corruptionRate)} | ${pct(r.availability)} | ${round(r.meanCorruptErrorBps, 0)} bps | ${money(r.profitUsd)} | ${money(r.expectedPenaltyUsd)} | ${r.profitUsd === 0 ? '—' : money(r.minStakeToDeterUsd)} | ${r.deterred ? 'yes' : '**no**'} |`)
  .join('\n')}

Failure threshold: **${threshold(set.threshold, (k) => `${k} of ${set.sources.length} colluding sources`)}**.`,
    )
    .join('\n\n');

  return `# Incentive Economics Stress Test (Issue #788)

Generated by \`npm run economics:stress\` from \`config/incentive-stress-test.json\`
and the revenue model in \`config/sustainability-model.json\`. Do not edit by hand;
\`npm run economics:stress:check\` fails when this file is stale.

The simulation reuses the publication rules of the aggregator
(\`services/aggregator/src/price-aggregation/aggregator.ts\`): cross-source median,
${config.policies.current.circuitBreakerDeviationPct}% circuit breaker against that median, and the legacy fallback to
suspicious prices, plus the contract's optional deviation guard
(\`utils::deviation_exceeds\`, compared with the last *accepted* price).
Each run is ${config.roundsPerRun} rounds with seed ${config.seed}; results are deterministic.

## Failure thresholds at a glance

| Stress dimension | Failure condition | Threshold |
| :--- | :--- | :--- |
| Low liquidity | Cost to move the reference venue by ${config.market.maxTolerableErrorBps} bps < attack profit on ${money(config.market.protocolTvlUsd)} TVL | liquidity factor ${threshold(ll.thresholds.manipulation)} |
| Low liquidity | Availability < ${slo.availabilityPct}% with a ${config.scenarios.lowLiquidity.contractDeviationGuardBps} bps contract guard (lockout) | liquidity factor ${threshold(ll.thresholds.guardLockout)} |
| Low liquidity | Honest sources flagged > ${slo.honestFlagBudgetPct}% under the recommended ${config.policies.recommended.circuitBreakerDeviationPct}% breaker | liquidity factor ${threshold(ll.thresholds.honestFalsePositives)} |
${collusion.map((s) => `| Collusion | Corrupted rounds > ${slo.corruptionBudgetPct}% (${s.label}) | ${threshold(s.threshold, (k) => `${k} of ${s.sources.length} sources`)} |`).join('\n')}
| Correlated outage | Availability < ${slo.availabilityPct}% under recommended quorum | shared-dependency outage probability ${threshold(co.thresholds.recommendedAvailability, (p) => pct(p, 1))} per round |
| Correlated outage | Availability < ${slo.availabilityPct}% under current quorum | ${threshold(co.thresholds.currentAvailability, (p) => pct(p, 1))} |
| Correlated outage | \`${co.member}\` operator margin < 0 with naive liveness penalties | ${threshold(co.thresholds.naiveOperatorExit, (p) => pct(p, 1))} |
| Correlated outage | Same, with correlated misses exempt from penalties | ${threshold(co.thresholds.exemptOperatorExit, (p) => pct(p, 1))} |
| Demand collapse | First operator exits / quorum lost | ${threshold(ds.thresholds.demandCollapse, (d) => `${d}× demand`)} / ${threshold(ds.thresholds.demandCollapseQuorum, (d) => `${d}× demand`)} |
| Demand surge (gas) | First operator exits / quorum lost | ${threshold(ds.thresholds.demandSurge, (d) => `${d}× demand`)} / ${threshold(ds.thresholds.demandSurgeQuorum, (d) => `${d}× demand`)} |

Baseline operating point (liquidity 1, no colluders, no shared outage, 1× demand) is **${result.baselineHealthy ? 'healthy' : 'NOT healthy'}**.

## 1. Low liquidity

Honest noise and per-round volatility scale with \`1/sqrt(liquidity)\`. Below a liquidity
factor of ${config.market.venueConsolidationBelowLiquidity}, providers are assumed to price off a single dominant venue, so one venue
has to be moved instead of a majority.

| Liquidity | Honest noise | Volatility / round | Availability (guard ${config.scenarios.lowLiquidity.contractDeviationGuardBps} bps) | Longest lockout | Honest flag rate (recommended) | Venues to move | Manipulation cost | Attack profit | Resistant |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
${ll.rows
  .map((r) => `| ${r.liquidityFactor} | ${r.honestNoiseBps} bps | ${r.volatilityBps} bps | ${pct(r.guardedAvailability)} | ${r.guardedMaxLockoutRounds} rounds | ${pct(r.recommendedHonestFlagRate)} | ${r.venues} | ${money(r.costUsd)} | ${money(r.profitUsd)} | ${r.resistant ? 'yes' : '**no**'} |`)
  .join('\n')}

The contract guard compares each submission with the last *accepted* price, so a single
gap larger than the guard rejects every later round until the market returns or an admin
changes the threshold. Any guard value must be set above the largest expected single-round
move of the most volatile asset sharing it (the guard is global, not per asset).

## 2. Collusion

Colluding sources report the same shifted price. For each coalition size the attacker
picks the shift from \`${JSON.stringify(config.scenarios.collusion.attackShiftsPct)}\`% that maximises corrupted error. The
penalty side assumes slashing of ${pct(config.incentives.slashFractionPerIncident, 0)} of stake with a ${pct(config.incentives.detectionProbability, 0)} chance the
off-chain reconciliation detects the incident (slashing is admin-triggered in
\`submission.rs\`; nothing slashes automatically).

${collusionTables}

## 3. Correlated outages

Dependency groups: ${Object.entries(config.scenarios.correlatedOutage.dependencyGroups).map(([g, m]) => `\`${g}\` → ${m.join(', ')}`).join('; ')}.
Each round every group fails with the swept probability; each source also fails
independently with probability ${config.scenarios.correlatedOutage.independentOutageProbability}.

| Shared outage p | Availability (current) | Availability (recommended) | Rounds with ≥2 misses | \`${co.member}\` penalty (naive) | Penalty (correlated exempt) | Margin (naive) | Margin (exempt) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${co.rows
  .map((r) => `| ${pct(r.groupOutageProbability, 1)} | ${pct(r.currentAvailability)} | ${pct(r.recommendedAvailability)} | ${pct(r.jointMissRate)} | ${money(r.naivePenaltyUsd)} | ${money(r.exemptPenaltyUsd)} | ${money(r.naiveMarginUsd)} | ${money(r.exemptMarginUsd)} |`)
  .join('\n')}

The current quorum of 1 stays available through shared outages precisely because it will
publish a single source's price, which is the weakness quantified in section 2.

## 4. Demand shocks

Revenue comes from \`calculateRevenue\` in \`scripts/sustainability-model.mjs\`. ${pct(config.incentives.rewardShareOfRevenue, 0)} of
revenue funds the reward pool, split evenly among active operators. Soroban fees surge with
network demand per \`gasSurgeAtDemand\`. Operators whose margin turns negative exit, highest
fixed cost first, and the pool is re-split among those who remain.

| Demand | Revenue | Reward pool | Gas multiplier | Gas / operator | Active operators | Quorum (≥${config.policies.recommended.minSources}) |
| ---: | ---: | ---: | ---: | ---: | ---: | :---: |
${ds.rows
  .map((r) => `| ${r.demandMultiplier}× | ${money(r.revenueUsd)} | ${money(r.rewardPoolUsd)} | ${round(r.gasMultiplier, 1)}× | ${money(r.gasPerOperatorUsd)} | ${r.activeOperators} | ${r.quorumHolds ? 'yes' : '**no**'} |`)
  .join('\n')}

Subscription base fees dominate revenue, so demand collapses mostly cut overage income;
the binding constraint is the fee surge that accompanies demand spikes.

## Recommendations

1. Enforce the catalog quorum at publish time (\`minSources ≥ 3\`) and drop the suspicious
   fallback; the current runtime minimum of 1 lets a single remaining source set the price.
2. Tighten the circuit breaker from ${config.policies.current.circuitBreakerDeviationPct}% toward ${config.policies.recommended.circuitBreakerDeviationPct}% only for assets whose low-liquidity
   honest flag rate stays inside budget (see section 1).
3. Add a fifth independent source before relying on stake alone: with four sources a
   two-source coalition moves the median, and the stake needed to deter it is in the table above.
4. Exempt rounds where two or more sources miss together from liveness penalties.
5. Keep the contract deviation guard unset, or above the largest single-round move of the
   most volatile asset, until it is made per asset.
6. Size the reward share so the highest-cost required operator stays profitable at the
   surge multiplier reached before the demand-surge threshold.

## Review procedure and completion evidence

- \`npm run economics:stress\` regenerates this report; \`npm run economics:stress:check\` fails when it is stale.
- \`node --test scripts/tests/incentive-stress-test.test.mjs\` covers normal, boundary and failure cases and
  runs in CI through \`node --test scripts/tests/*.test.mjs\`.
- Re-run on every change to aggregation rules, staking parameters, the source set or the
  sustainability model, and at the ${config.reviewIntervalDays}-day review (next: ${config.nextReviewDate}).

## Owner, scope and limitations

- **Owner**: ${config.owner}.
- **Scope**: the four production sources, one representative asset, the aggregation and
  contract guard rules above, and the proposed incentive parameters in \`docs/SOURCE_INCENTIVES.md\`.
- **Limitations**: rounds are independent draws (outages have no duration); the circuit
  breaker's 3-success recovery is not modelled; manipulation cost is linear in depth;
  the reward pool and liveness penalty are proposals, not deployed behaviour.

## Compatibility, monitoring and operational impact

- **Compatibility**: offline analysis only. No runtime, API, contract or storage change.
- **Monitoring**: the thresholds map to existing signals — \`feed_quorum_reporting_sources\`
  and \`feed_quorum_evaluated_total{result="unsatisfied"}\` (quorum and outages), circuit-breaker
  suspicious-source logs (honest flag rate), and \`PriceDeviationTooLarge\` contract errors (guard lockout).
- **Operational impact**: none on serving paths; the run takes seconds and needs no network.

## Rollout and rollback

- **Rollout**: merge the config, model, tests and this report. Policy changes recommended
  above are separate, reviewed changes that must re-run this model before and after.
- **Rollback**: revert the commit; nothing else depends on these files.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const sustainabilityModel = JSON.parse(await readFile(sustainabilityPath, 'utf8'));
  const result = runIncentiveStressTest(config, sustainabilityModel);

  if (args.includes('--json')) {
    const { config: _ignored, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
    return;
  }

  const rendered = renderReport(result);
  if (args.includes('--check')) {
    const existing = await readFile(reportPath, 'utf8').catch(() => '');
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/INCENTIVE_STRESS_TEST.md is stale. Run: npm run economics:stress');
      process.exit(1);
    }
    console.log('Incentive stress-test report is up to date.');
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, reportPath)} (baseline ${result.baselineHealthy ? 'healthy' : 'NOT healthy'}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
