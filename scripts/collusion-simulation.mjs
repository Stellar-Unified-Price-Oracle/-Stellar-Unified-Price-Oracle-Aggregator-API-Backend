#!/usr/bin/env node

/**
 * scripts/collusion-simulation.mjs — issue #790
 *
 * Runs adversarial economic simulations of coordinated bad submissions
 * (outliers, breaker evasion, cartels, DoS-plus-one, sybil floods, slow drift)
 * against each rule set and checks whether the current rewards, penalties and
 * quorum rules resist them. Verdicts are pinned in config/collusion-scenarios.json;
 * any rule or parameter change that alters a verdict fails --check and CI.
 * Generates docs/COLLUSION_RESISTANCE_REPORT.md.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { money, pct, round, simulateRounds } from './lib/oracle-economics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  scenarios: path.join(root, 'config', 'collusion-scenarios.json'),
  report: path.join(root, 'docs', 'COLLUSION_RESISTANCE_REPORT.md'),
};

export const VERDICTS = ['resisted', 'halted', 'deterred', 'vulnerable'];

export function validateScenarios(scenarios, params) {
  const errors = [];
  if (!scenarios?.owner) errors.push('owner is required');
  const ruleIds = new Set();
  for (const rs of scenarios?.ruleSets ?? []) {
    if (ruleIds.has(rs.id)) errors.push(`duplicate rule set ${rs.id}`);
    ruleIds.add(rs.id);
    if (!params.policies?.[rs.policy]) errors.push(`rule set ${rs.id} references unknown policy ${rs.policy}`);
    if (!['production', 'expanded'].includes(rs.sourceSet)) errors.push(`rule set ${rs.id} has unknown sourceSet ${rs.sourceSet}`);
  }
  for (const attack of scenarios?.attacks ?? []) {
    const staked = (attack.colluders ?? 0) + (attack.sybils ?? 0);
    if (staked < 1) errors.push(`attack ${attack.id} needs at least one colluder or sybil`);
    const s = attack.shift ?? {};
    if (![s.pct, s.breakerMultiple, s.driftBpsPerRound].some((v) => v > 0)) errors.push(`attack ${attack.id} needs a positive shift`);
  }
  if (ruleIds.size === 0) errors.push('at least one rule set is required');
  if (errors.length) throw new Error(`Invalid collusion scenarios:\n- ${errors.join('\n- ')}`);
}

export function shiftFor(attack, policy) {
  const s = attack.shift;
  const breakerBps = policy.circuitBreakerDeviationPct * 100;
  if (s.driftBpsPerRound) {
    const cap = s.capBreakerMultiple ? s.capBreakerMultiple * breakerBps : Infinity;
    return (i) => Math.min(cap, s.driftBpsPerRound * (i + 1));
  }
  if (s.breakerMultiple) return s.breakerMultiple * breakerBps;
  return s.pct * 100;
}

export function buildRun(attack, ruleSet, params) {
  const policy = params.policies[ruleSet.policy];
  const base = ruleSet.sourceSet === 'expanded' ? params.scenarios.collusion.expandedSourceSet : params.sources;
  const colluders = attack.colluders ?? 0;
  if (colluders > base.length) throw new Error(`attack ${attack.id} needs ${colluders} colluders but ${ruleSet.id} has ${base.length} sources`);
  const sybils = Array.from({ length: attack.sybils ?? 0 }, (_, i) => `sybil-${i + 1}`);
  const sources = [...base, ...sybils];
  const attackers = [...base.slice(base.length - colluders), ...sybils];
  const honest = base.slice(0, base.length - colluders);
  const forcedOffline = honest.slice(0, attack.dosHonest ?? 0);
  const issuers = Object.fromEntries(sybils.map((s) => [s, 'sybil-operator']));
  return { policy, sources, attackers, forcedOffline, issuers, stakedAttackers: colluders + sybils.length, honestCount: base.length - colluders };
}

export function verdictFor({ run, staked, params }) {
  const { slo, market: m, incentives: inc } = params;
  const corrupted = run.corruptionRate > slo.corruptionBudgetPct / 100;
  const profitUsd = corrupted ? m.protocolTvlUsd * m.extractableFractionOfError * (run.meanCorruptErrorBps / 10_000) : 0;
  const expectedPenaltyUsd = staked * inc.stakePerSourceUsd * inc.slashFractionPerIncident * inc.detectionProbability;
  const stakeToDeterUsd = profitUsd > 0 ? profitUsd / (staked * inc.slashFractionPerIncident * inc.detectionProbability) : 0;
  let verdict;
  if (!corrupted) verdict = run.availability * 100 >= slo.availabilityPct ? 'resisted' : 'halted';
  else verdict = expectedPenaltyUsd >= profitUsd ? 'deterred' : 'vulnerable';
  return { verdict, corrupted, profitUsd, expectedPenaltyUsd, stakeToDeterUsd };
}

export function runCollusionSimulation(scenarios, params) {
  validateScenarios(scenarios, params);
  const m = params.market;
  const cells = [];
  for (const attack of scenarios.attacks) {
    for (const ruleSet of scenarios.ruleSets) {
      const setup = buildRun(attack, ruleSet, params);
      const run = simulateRounds({
        rounds: scenarios.roundsPerRun,
        seed: scenarios.seed,
        sources: setup.sources,
        policy: setup.policy,
        referencePrice: m.referencePriceUsd,
        honestNoiseBps: m.honestNoiseBps,
        volatilityBps: m.volatilityBpsPerRound,
        maxTolerableErrorBps: m.maxTolerableErrorBps,
        guardBps: ruleSet.guardBps,
        attackers: setup.attackers,
        attackShiftBps: shiftFor(attack, setup.policy),
        forcedOffline: setup.forcedOffline,
        issuers: setup.issuers,
        attackStartRound: scenarios.warmupRounds,
      });
      cells.push({
        attack: attack.id,
        ruleSet: ruleSet.id,
        stakedAttackers: setup.stakedAttackers,
        sourceCount: setup.sources.length,
        availability: run.availability,
        corruptionRate: run.corruptionRate,
        meanCorruptErrorBps: run.meanCorruptErrorBps,
        maxConsecutiveUnavailable: run.maxConsecutiveUnavailable,
        ...verdictFor({ run, staked: setup.stakedAttackers, params }),
      });
    }
  }
  const mismatches = cells
    .map((c) => ({ ...c, expected: scenarios.expectedVerdicts?.[c.attack]?.[c.ruleSet] ?? null }))
    .filter((c) => c.expected !== c.verdict);
  const summary = Object.fromEntries(
    scenarios.ruleSets.map((rs) => {
      const row = cells.filter((c) => c.ruleSet === rs.id);
      return [rs.id, Object.fromEntries(VERDICTS.map((v) => [v, row.filter((c) => c.verdict === v).length]))];
    }),
  );
  return { scenarios, params, cells, mismatches, summary };
}

const badge = (v) => (v === 'vulnerable' ? '**vulnerable**' : v);

export function renderReport(result) {
  const { scenarios: sc, params, cells, summary } = result;
  const cell = (a, r) => cells.find((c) => c.attack === a && c.ruleSet === r);
  const inc = params.incentives;
  const current = summary.current ?? {};
  const listBy = (ruleSet, keep) =>
    cells.filter((c) => c.ruleSet === ruleSet && keep(c)).map((c) => `\`${c.attack}\``).join(', ') || 'none';
  return `# Collusion Resistance of Rewards, Penalties and Quorum Rules (Issue #790)

Generated by \`npm run economics:collusion\` from \`config/collusion-scenarios.json\` with market,
incentive and policy parameters from \`${sc.parametersFrom}\`. Do not edit by hand;
\`npm run economics:collusion:check\` fails when this file is stale **or when any verdict differs
from \`expectedVerdicts\`**, so a rule change that weakens (or strengthens) resistance cannot merge
without this review being updated.

## Verdict matrix

- **resisted** — corrupted rounds ≤ ${params.slo.corruptionBudgetPct}% and availability ≥ ${params.slo.availabilityPct}%.
- **halted** — integrity held but availability fell below the SLO (the attack becomes a liveness attack).
- **deterred** — the price was corrupted but expected slashing (${pct(inc.slashFractionPerIncident, 0)} of a ${money(inc.stakePerSourceUsd)} stake × ${pct(inc.detectionProbability, 0)} detection per staked attacker) exceeds the attack profit.
- **vulnerable** — corrupted and profitable.

| Attack | ${sc.ruleSets.map((r) => r.label).join(' | ')} |
| :--- | ${sc.ruleSets.map(() => ':---:').join(' | ')} |
${sc.attacks.map((a) => `| \`${a.id}\` | ${sc.ruleSets.map((r) => badge(cell(a.id, r.id).verdict)).join(' | ')} |`).join('\n')}

**Do the current rules resist coordinated bad submissions?** Under the current runtime rules
${current.resisted ?? 0} of ${sc.attacks.length} attacks are resisted, ${current.halted ?? 0} halted, ${current.deterred ?? 0} deterred and **${current.vulnerable ?? 0} vulnerable**.
Resisted: ${listBy('current', (c) => c.verdict === 'resisted')}. Not resisted: ${listBy('current', (c) => c.verdict !== 'resisted')}.
Attacks the proposed ${money(inc.stakePerSourceUsd)} stake deters under current rules: ${listBy('current', (c) => c.verdict === 'deterred')}.

## Attack details

${sc.attacks
  .map(
    (a) => `### \`${a.id}\`

${a.description}.

| Rule set | Sources | Staked attackers | Corrupted rounds | Availability | Longest outage | Mean error when corrupted | Attack profit | Expected penalty | Stake per attacker to deter | Verdict |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
${sc.ruleSets
  .map((r) => {
    const c = cell(a.id, r.id);
    return `| ${r.label} | ${c.sourceCount} | ${c.stakedAttackers} | ${pct(c.corruptionRate)} | ${pct(c.availability)} | ${c.maxConsecutiveUnavailable} rounds | ${round(c.meanCorruptErrorBps, 0)} bps | ${money(c.profitUsd)} | ${money(c.expectedPenaltyUsd)} | ${c.profitUsd > 0 ? money(c.stakeToDeterUsd) : '—'} | ${badge(c.verdict)} |`;
  })
  .join('\n')}`,
  )
  .join('\n\n')}

## Why each rule matters

1. **Quorum of 1 (current runtime).** \`dos-plus-one\` needs a single staked source: knocking two
   honest sources offline leaves the liar and one honest source, and the median of two is their
   midpoint. A quorum of 3 converts this into a halt.
2. **20% circuit breaker with suspicious fallback.** A coordinated pair moves the median far enough
   that every report is flagged, and the fallback then publishes the median of all of them.
   Removing the fallback and tightening the breaker caps how far a pair can move the price, but with
   four sources the pair still sets one of the two middle values.
3. **Distinct issuers.** Sybil identities only help if they count separately toward quorum and the
   median; \`distinctIssuersOnly\` collapses them to one vote.
4. **The contract deviation guard** turns sudden coordinated jumps into a lockout (halt) but does
   nothing against a slow drift, because it compares each submission with the last accepted price.
   It only delays moderate shifts: once the market moves toward the manipulated level, the guard
   accepts it and the corrupted price becomes the new baseline (see \`sybil-flood\`).
5. **A fifth independent source** is what moves the honest-majority bound from 2 to 3 colluders.
   Majority cartels remain beyond any median rule; only stake and detection can deter them.
6. **Penalties.** Slashing is admin-triggered (\`slash\` in \`submission.rs\`) and rewards are not paid
   on-chain yet, so deterrence depends entirely on off-chain detection and the stake size. The
   "stake per attacker to deter" column is the minimum that makes each corrupting strategy unprofitable.

## Repeatable review procedure

1. Change rules or parameters (aggregation policy, stake, slash fraction, source set).
2. Run \`npm run economics:collusion\`; review any verdict changes in the matrix.
3. If a change is intended, update \`expectedVerdicts\` in \`config/collusion-scenarios.json\` in the
   same pull request, with the reason in the PR description.
4. \`npm run economics:collusion:check\` and \`node --test scripts/tests/collusion-simulation.test.mjs\`
   (run in CI) must pass.

Review every ${sc.reviewIntervalDays} days (next: ${sc.nextReviewDate}).

## Owner, scope and limitations

- **Owner**: ${sc.owner}.
- **Scope**: the six attack strategies above, the four rule sets, one representative asset,
  ${sc.roundsPerRun} rounds per cell with seed ${sc.seed}. Attacks start after ${sc.warmupRounds} honest warm-up rounds so the
  contract guard has an accepted baseline, as it would on a live feed.
- **Limitations**: detection probability is an assumption, not a measured rate; profit is a
  one-shot extraction estimate; attackers do not adapt to the breaker's 3-success recovery;
  sybil admission assumes sources can join by staking.

## Compatibility, monitoring and operational impact

- **Compatibility**: offline analysis only; no runtime, API, contract or storage change.
- **Monitoring**: circuit-breaker suspicious-source warnings and the aggregation evidence
  \`fallback: "suspicious"\` flag (breaker evasion), \`feed_quorum_evaluated_total{result="unsatisfied"}\`
  (DoS-plus-one halts), \`PriceDeviationTooLarge\` contract errors (guard lockouts), and
  \`SourceSlashed\` contract events (penalties actually applied).
- **Operational impact**: none on serving paths.

## Rollout and rollback

- **Rollout**: merge the scenarios, simulator, tests and this report. Each recommended rule change
  is a separate reviewed change that must update \`expectedVerdicts\` in the same PR.
- **Rollback**: revert the commit; nothing else depends on these files.
`;
}

export async function loadInputs() {
  const scenarios = JSON.parse(await readFile(paths.scenarios, 'utf8'));
  const params = JSON.parse(await readFile(path.join(root, scenarios.parametersFrom), 'utf8'));
  return { scenarios, params };
}

async function main() {
  const args = process.argv.slice(2);
  const { scenarios, params } = await loadInputs();
  const result = runCollusionSimulation(scenarios, params);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ cells: result.cells, mismatches: result.mismatches, summary: result.summary }, null, 2));
    return;
  }
  const rendered = renderReport(result);
  if (args.includes('--check')) {
    let failed = false;
    for (const m of result.mismatches) {
      console.error(`Verdict changed: ${m.attack} under ${m.ruleSet} is ${m.verdict}, expected ${m.expected}`);
      failed = true;
    }
    const existing = await readFile(paths.report, 'utf8').catch(() => '');
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/COLLUSION_RESISTANCE_REPORT.md is stale. Run: npm run economics:collusion');
      failed = true;
    }
    if (failed) process.exit(1);
    console.log('Collusion resistance report and verdicts are up to date.');
    return;
  }
  await writeFile(paths.report, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, paths.report)}.`);
  for (const m of result.mismatches) console.warn(`Verdict differs from expected: ${m.attack} / ${m.ruleSet}: ${m.verdict} (expected ${m.expected})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
