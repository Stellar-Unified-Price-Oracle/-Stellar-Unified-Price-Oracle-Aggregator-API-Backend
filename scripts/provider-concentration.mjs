#!/usr/bin/env node

/**
 * scripts/provider-concentration.mjs — issue #789
 *
 * Reports provider concentration across the active feed catalog (weight HHI,
 * spend share, hosting dependencies, declared required sources), the
 * operational cost of that concentration, and the cost of maintaining
 * independent alternatives. Generates and validates
 * docs/PROVIDER_CONCENTRATION_REPORT.md. Because the report is derived from
 * config/feed-catalog.json, any catalog change makes it stale and fails CI
 * until the concentration is re-reviewed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { calculateRevenue } from './sustainability-model.mjs';
import { hhi, money, round } from './lib/oracle-economics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  config: path.join(root, 'config', 'provider-concentration.json'),
  catalog: path.join(root, 'config', 'feed-catalog.json'),
  costQuality: path.join(root, 'config', 'feed-cost-quality.json'),
  sustainability: path.join(root, 'config', 'sustainability-model.json'),
  report: path.join(root, 'docs', 'PROVIDER_CONCENTRATION_REPORT.md'),
};

export function classifyHhi(value, policy) {
  if (value >= policy.hhiHigh) return 'high';
  if (value >= policy.hhiModerate) return 'moderate';
  return 'low';
}

export function activeFeeds(catalog) {
  const feeds = (catalog?.feeds ?? []).filter((f) => f.lifecycle?.state === 'active');
  if (feeds.length === 0) throw new Error('feed catalog has no active feeds');
  return feeds.map((f) => ({
    feedId: f.feedId,
    sources: f.eligibleSources.map((s) => ({ source: s.source, weightBps: s.weightBps, required: s.required === true })),
  }));
}

export function validateInputs(config, feeds) {
  const errors = [];
  if (!config?.owner) errors.push('owner is required');
  const p = config?.policy ?? {};
  if (!(p.quorumMinSources >= 1)) errors.push('policy.quorumMinSources must be >= 1');
  if (!(p.hhiModerate > 0 && p.hhiHigh > p.hhiModerate)) errors.push('policy.hhiHigh must exceed policy.hhiModerate');
  for (const feed of feeds) {
    for (const s of feed.sources) {
      if (!config.providers?.[s.source]) errors.push(`provider ${s.source} (feed ${feed.feedId}) has no entry in providers`);
      if (!(s.weightBps > 0)) errors.push(`feed ${feed.feedId} source ${s.source} has non-positive weight`);
    }
  }
  for (const [name, provider] of Object.entries(config?.providers ?? {})) {
    if (!(provider.monthlyCostUsd >= 0)) errors.push(`provider ${name} needs monthlyCostUsd >= 0`);
    if (!(provider.hostingDependency in (config.hostingDependencyOutageHoursPerYear ?? {}))) {
      errors.push(`provider ${name} hosting dependency ${provider.hostingDependency} has no outage estimate`);
    }
  }
  for (const alt of config?.alternatives ?? []) {
    if (config.providers?.[alt.id]) errors.push(`alternative ${alt.id} duplicates an existing provider`);
    if (!(alt.weightBps > 0)) errors.push(`alternative ${alt.id} needs weightBps > 0`);
  }
  if (errors.length) throw new Error(`Invalid provider concentration inputs:\n- ${errors.join('\n- ')}`);
}

function hostingOf(config, extra, source) {
  return config.providers[source]?.hostingDependency ?? extra.find((a) => a.id === source)?.hostingDependency;
}

/**
 * Expected feed-down hours per year. A feed is down while fewer than the quorum
 * of its sources are live, or (when `enforceRequired`) while a required source
 * is down. Single-provider and whole-hosting-group outages are counted;
 * overlapping independent outages are second-order and ignored.
 */
export function expectedDowntime(config, feeds, { extra = [], enforceRequired }) {
  const quorum = config.policy.quorumMinSources;
  const outageHours = (s) => config.providers[s]?.expectedOutageHoursPerYear ?? extra.find((a) => a.id === s)?.expectedOutageHoursPerYear ?? 0;
  const events = [];
  const allSources = new Set(feeds.flatMap((f) => f.sources.map((s) => s.source)));
  for (const s of allSources) events.push({ label: s, hours: outageHours(s), down: new Set([s]) });
  for (const [group, hours] of Object.entries(config.hostingDependencyOutageHoursPerYear)) {
    const down = new Set([...allSources].filter((s) => hostingOf(config, extra, s) === group));
    if (down.size > 0) events.push({ label: `hosting:${group}`, hours, down });
  }
  let feedHours = 0;
  const blocking = [];
  for (const event of events) {
    const blocked = feeds.filter((f) => {
      const live = f.sources.filter((s) => !event.down.has(s.source));
      const requiredLost = enforceRequired && f.sources.some((s) => s.required && event.down.has(s.source));
      return live.length < quorum || requiredLost;
    });
    if (blocked.length > 0) blocking.push({ event: event.label, feeds: blocked.map((f) => f.feedId), hours: event.hours });
    feedHours += blocked.length * event.hours;
  }
  return { feedHours, blocking };
}

export function withAlternatives(feeds, alternatives) {
  return feeds.map((f) => ({
    ...f,
    sources: [...f.sources, ...alternatives.map((a) => ({ source: a.id, weightBps: a.weightBps, required: false }))],
  }));
}

export function concentrationMetrics(config, feeds, extra = []) {
  const perFeed = feeds.map((f) => {
    const value = hhi(f.sources.map((s) => s.weightBps));
    const total = f.sources.reduce((sum, s) => sum + s.weightBps, 0);
    const top = f.sources.reduce((a, b) => (b.weightBps > a.weightBps ? b : a));
    const byHosting = {};
    for (const s of f.sources) {
      const g = hostingOf(config, extra, s.source);
      byHosting[g] = (byHosting[g] ?? 0) + s.weightBps / total;
    }
    const [maxGroup, maxGroupShare] = Object.entries(byHosting).sort((a, b) => b[1] - a[1])[0];
    return {
      feedId: f.feedId,
      sourceCount: f.sources.length,
      hhi: value,
      effectiveProviders: 10_000 / value,
      topProvider: top.source,
      topShare: top.weightBps / total,
      required: f.sources.filter((s) => s.required).map((s) => s.source),
      hostingHhi: hhi(Object.values(byHosting)),
      maxHostingGroup: maxGroup,
      maxHostingGroupShare: maxGroupShare,
    };
  });
  const fleetHhi = perFeed.reduce((s, f) => s + f.hhi, 0) / perFeed.length;
  return { perFeed, fleetHhi, maxFeedHhi: Math.max(...perFeed.map((f) => f.hhi)), maxHostingGroupShare: Math.max(...perFeed.map((f) => f.maxHostingGroupShare)) };
}

export function spendConcentration(config, extra = []) {
  const entries = [
    ...Object.entries(config.providers).map(([id, p]) => [id, p.monthlyCostUsd]),
    ...extra.map((a) => [a.id, a.monthlyCostUsd]),
  ];
  const total = entries.reduce((s, [, c]) => s + c, 0);
  return {
    totalMonthlyUsd: total,
    hhi: hhi(entries.map(([, c]) => c)),
    shares: entries.map(([id, c]) => ({ id, monthlyCostUsd: c, share: c / total })).sort((a, b) => b.share - a.share),
  };
}

export function alternativeAnnualCost(config, alt) {
  const recurring = 12 * (alt.monthlyCostUsd + alt.opsHoursMonthly * alt.opsHourlyUsd);
  const amortized = (alt.integrationOneOffUsd / config.policy.amortizationMonths) * 12;
  return { recurringUsd: recurring, amortizedIntegrationUsd: amortized, totalUsd: recurring + amortized };
}

function subsets(items) {
  const out = [];
  for (let mask = 0; mask < 1 << items.length; mask++) out.push(items.filter((_, i) => mask & (1 << i)));
  return out;
}

export function analyzeConcentration({ config, catalog, costQuality, sustainabilityModel }) {
  const feeds = activeFeeds(catalog);
  validateInputs(config, feeds);
  const p = config.policy;
  const revenueMonthlyUsd = calculateRevenue(sustainabilityModel, 1).totalMonthlyRevenueUsd;
  const revenuePerFeedHourUsd = revenueMonthlyUsd / (sustainabilityModel.assumptions.hoursPerMonth * feeds.length);
  const lossPerFeedHourUsd = revenuePerFeedHourUsd * (1 + p.slaCreditMultiplier);
  const ingestionUsd = (costQuality?.feeds ?? []).reduce((s, f) => s + (f.costMetrics?.providerIngestionMonthlyUsd ?? 0), 0);
  const providerSpendUsd = Object.values(config.providers).reduce((s, x) => s + x.monthlyCostUsd, 0);

  const current = concentrationMetrics(config, feeds);
  const spend = spendConcentration(config);
  const downtimeRuntime = expectedDowntime(config, feeds, { enforceRequired: false });
  const downtimeDeclared = expectedDowntime(config, feeds, { enforceRequired: true });

  const portfolios = subsets(config.alternatives).map((alts) => {
    const expanded = withAlternatives(feeds, alts);
    const metrics = concentrationMetrics(config, expanded, alts);
    const runtime = expectedDowntime(config, expanded, { extra: alts, enforceRequired: false });
    const declared = expectedDowntime(config, expanded, { extra: alts, enforceRequired: true });
    const cost = alts.reduce((s, a) => s + alternativeAnnualCost(config, a).totalUsd, 0);
    const avoidedFeedHours = downtimeRuntime.feedHours - runtime.feedHours;
    const avoidedLossUsd = avoidedFeedHours * lossPerFeedHourUsd;
    return {
      alternatives: alts.map((a) => a.id),
      sourceCount: expanded[0].sources.length,
      annualCostUsd: cost,
      fleetHhi: metrics.fleetHhi,
      maxHostingGroupShare: metrics.maxHostingGroupShare,
      runtimeFeedHours: runtime.feedHours,
      declaredFeedHours: declared.feedHours,
      blockingEvents: runtime.blocking.map((b) => b.event),
      avoidedFeedHours,
      avoidedLossUsd,
      netAnnualUsd: avoidedLossUsd - cost,
      breakEvenLossPerFeedHourUsd: avoidedFeedHours > 0 ? cost / avoidedFeedHours : Infinity,
      spendHhi: spendConcentration(config, alts).hhi,
      meetsTarget:
        metrics.maxFeedHhi <= p.targetFeedHhi &&
        metrics.maxHostingGroupShare * 100 <= p.maxHostingGroupWeightSharePct &&
        runtime.blocking.length === 0,
    };
  });
  const meeting = portfolios.filter((x) => x.meetsTarget).sort((a, b) => a.annualCostUsd - b.annualCostUsd);

  const findings = [];
  const declaredSpof = [...new Set(current.perFeed.flatMap((f) => f.required))];
  for (const s of declaredSpof) {
    const blocked = current.perFeed.filter((f) => f.required.includes(s)).length;
    findings.push(`\`${s}\` is declared \`required\` on ${blocked} of ${feeds.length} active feeds; if that flag is enforced, its outage blocks them all. The runtime does not enforce \`required\` today.`);
  }
  for (const b of downtimeRuntime.blocking) {
    findings.push(`Outage event \`${b.event}\` drops ${b.feeds.length} feed(s) below the ${p.quorumMinSources}-source quorum (${b.hours} h/year expected).`);
  }
  const highFeeds = current.perFeed.filter((f) => classifyHhi(f.hhi, p) === 'high');
  if (highFeeds.length) {
    findings.push(`${highFeeds.length} of ${feeds.length} feeds are highly concentrated (HHI ≥ ${p.hhiHigh}); four providers cannot go below HHI 2500.`);
  }
  for (const s of spend.shares.filter((x) => x.share * 100 > p.maxProviderSpendSharePct)) {
    findings.push(`\`${s.id}\` takes ${round(s.share * 100, 1)}% of provider spend, above the ${p.maxProviderSpendSharePct}% limit.`);
  }

  return {
    config,
    feeds,
    revenueMonthlyUsd,
    lossPerFeedHourUsd,
    ingestionUsd,
    providerSpendUsd,
    current,
    spend,
    downtimeRuntime,
    downtimeDeclared,
    portfolios,
    recommended: meeting[0] ?? null,
    findings,
  };
}

export const collusionThreshold = (sourceCount) => Math.ceil(sourceCount / 2);

const share = (x) => `${round(x * 100, 1)}%`;

export function renderReport(a) {
  const { config: c, current, spend, portfolios } = a;
  const p = c.policy;
  const baseline = portfolios.find((x) => x.alternatives.length === 0);
  return `# Provider Concentration Exposure (Issue #789)

Generated by \`npm run economics:concentration\` from \`config/provider-concentration.json\`,
\`config/feed-catalog.json\` (active feeds), \`config/feed-cost-quality.json\` and
\`config/sustainability-model.json\`. Do not edit by hand; \`npm run economics:concentration:check\`
fails when this file is stale, so any catalog change forces this review to be re-run.

## Findings

${a.findings.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## Concentration by feed

HHI is computed on catalog \`weightBps\` (0–10000): below ${p.hhiModerate} low, ${p.hhiModerate}–${p.hhiHigh - 1} moderate, ${p.hhiHigh}+ high.

| Feed | Sources | Weight HHI | Class | Effective providers | Top provider (share) | Declared required | Largest hosting group (share) | Hosting HHI |
| :--- | ---: | ---: | :--- | ---: | :--- | :--- | :--- | ---: |
${current.perFeed
  .map((f) => `| \`${f.feedId}\` | ${f.sourceCount} | ${round(f.hhi, 0)} | ${classifyHhi(f.hhi, p)} | ${round(f.effectiveProviders, 2)} | ${f.topProvider} (${share(f.topShare)}) | ${f.required.join(', ') || '—'} | \`${f.maxHostingGroup}\` (${share(f.maxHostingGroupShare)}) | ${round(f.hostingHhi, 0)} |`)
  .join('\n')}

Fleet average weight HHI: **${round(current.fleetHhi, 0)}**.

## Spend concentration

Provider spend in this model (${money(a.providerSpendUsd)}/month) reconciles with the
\`providerIngestionMonthlyUsd\` total in \`config/feed-cost-quality.json\` (${money(a.ingestionUsd)}/month).

| Provider | Monthly cost | Share of spend | Hosting dependency |
| :--- | ---: | ---: | :--- |
${spend.shares.map((s) => `| ${s.id} | ${money(s.monthlyCostUsd)} | ${share(s.share)} | \`${c.providers[s.id].hostingDependency}\` |`).join('\n')}

Spend HHI: **${round(spend.hhi, 0)}**.

## Operational cost of concentration

Loss per feed-hour of downtime is revenue per feed-hour (${money(a.revenueMonthlyUsd)}/month across
${a.feeds.length} feeds) plus ${share(p.slaCreditMultiplier)} SLA credits: **${money(a.lossPerFeedHourUsd)}**.

| Policy | Expected feed-down hours / year | Expected annual loss | Blocking outage events |
| :--- | ---: | ---: | :--- |
| Runtime today (quorum ${p.quorumMinSources}, \`required\` not enforced) | ${round(a.downtimeRuntime.feedHours, 1)} | ${money(a.downtimeRuntime.feedHours * a.lossPerFeedHourUsd)} | ${a.downtimeRuntime.blocking.map((b) => `\`${b.event}\``).join(', ') || '—'} |
| Catalog as declared (\`required\` enforced) | ${round(a.downtimeDeclared.feedHours, 1)} | ${money(a.downtimeDeclared.feedHours * a.lossPerFeedHourUsd)} | ${a.downtimeDeclared.blocking.map((b) => `\`${b.event}\``).join(', ') || '—'} |

Integrator-side losses (halted liquidations, paused markets) are not included; the
break-even column below states how large they would need to be for each option to pay.

## Cost of independent alternatives

Annual cost = 12 × (subscription + ops hours × rate) + integration amortized over
${p.amortizationMonths} months. Costs are estimates (see \`status\` in the config) and must be
replaced with quotes before a purchase decision.

| Alternative | Kind | Status | Annual cost | Hosting | Weight |
| :--- | :--- | :--- | ---: | :--- | ---: |
${c.alternatives.map((alt) => `| \`${alt.id}\` | ${alt.kind} | ${alt.status} | ${money(alternativeAnnualCost(c, alt).totalUsd)} | \`${alt.hostingDependency}\` | ${alt.weightBps} bps |`).join('\n')}

### Portfolios

Target: every feed HHI ≤ ${p.targetFeedHhi}, no hosting group above ${p.maxHostingGroupWeightSharePct}% of weight, and no single
outage event that breaks quorum.

| Added alternatives | Annual cost | Fleet HHI | Max hosting share | Feed-down h/yr (runtime) | Feed-down h/yr (declared) | Avoided loss | Net / year | Break-even loss per feed-hour | Spend HHI | Meets target |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
${portfolios
  .map((x) => `| ${x.alternatives.map((id) => `\`${id}\``).join(' + ') || '_none (today)_'} | ${money(x.annualCostUsd)} | ${round(x.fleetHhi, 0)} | ${share(x.maxHostingGroupShare)} | ${round(x.runtimeFeedHours, 1)} | ${round(x.declaredFeedHours, 1)} | ${money(x.avoidedLossUsd)} | ${money(x.netAnnualUsd)} | ${x.alternatives.length ? money(x.breakEvenLossPerFeedHourUsd) : '—'} | ${round(x.spendHhi, 0)} | ${x.meetsTarget ? 'yes' : 'no'} |`)
  .join('\n')}

${a.recommended
  ? `Cheapest portfolio meeting the target: **${a.recommended.alternatives.map((id) => `\`${id}\``).join(' + ')}** at **${money(a.recommended.annualCostUsd)}/year**, removing ${round(a.recommended.avoidedFeedHours, 1)} expected feed-down hours per year versus today (${round(baseline.runtimeFeedHours, 1)}). On direct revenue and SLA credits alone it pays back only if integrator losses exceed ${money(a.recommended.breakEvenLossPerFeedHourUsd)} per feed-hour; it also raises the coalition needed to move the median from ${collusionThreshold(baseline.sourceCount)} to ${collusionThreshold(a.recommended.sourceCount)} sources (see \`docs/INCENTIVE_STRESS_TEST.md\`).`
  : 'No portfolio of the listed alternatives meets the target; widen the candidate list.'}

## Recommendations

1. Relax \`required: true\` on the dominant provider once an independent alternative is
   live, or document why a fleet-wide single point of failure is accepted.
2. Move one of the two providers on the shared hosting dependency, or add an
   alternative on independent infrastructure, so no single hosting outage breaks quorum.
3. Treat a fifth source as the precondition for any HHI target below 2500.

## Review procedure and completion evidence

- \`npm run economics:concentration\` regenerates this report; \`npm run economics:concentration:check\` fails when stale.
- \`node --test scripts/tests/provider-concentration.test.mjs\` covers normal, boundary and
  failure cases (single-provider catalog, missing provider metadata, equal weights,
  hosting-group outages) and runs in CI.
- Review every ${c.reviewIntervalDays} days (next: ${c.nextReviewDate}), on every catalog change, and on any
  provider contract renewal.

## Owner, scope and limitations

- **Owner**: ${c.owner}.
- **Scope**: active feeds in \`config/feed-catalog.json\`, the four production providers and
  the listed candidate alternatives.
- **Limitations**: outage hours are planning estimates, not measured SLOs; concurrent
  independent outages are ignored; alternative costs are estimates pending quotes;
  catalog weights are used as the concentration measure, not realised contribution.

## Compatibility, monitoring and operational impact

- **Compatibility**: offline analysis and documentation only; no runtime, API or contract change.
- **Monitoring**: \`feed_quorum_reporting_sources\` and
  \`feed_quorum_evaluated_total{result="unsatisfied"}\` show the live effect of a provider or
  hosting outage; this report's staleness check is the change-time control.
- **Operational impact**: none on serving paths.

## Rollout and rollback

- **Rollout**: merge the config, model, tests and this report. Provider additions or
  \`required\` changes go through the feed catalog release process and must re-run this model.
- **Rollback**: revert the commit; nothing else depends on these files.
`;
}

async function loadInputs() {
  const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
  return {
    config: await read(paths.config),
    catalog: await read(paths.catalog),
    costQuality: await read(paths.costQuality),
    sustainabilityModel: await read(paths.sustainability),
  };
}

export { loadInputs };

async function main() {
  const args = process.argv.slice(2);
  const analysis = analyzeConcentration(await loadInputs());
  if (args.includes('--json')) {
    const { config: _ignored, ...rest } = analysis;
    console.log(JSON.stringify(rest, (_, v) => (v === Infinity ? null : v), 2));
    return;
  }
  const rendered = renderReport(analysis);
  if (args.includes('--check')) {
    const existing = await readFile(paths.report, 'utf8').catch(() => '');
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/PROVIDER_CONCENTRATION_REPORT.md is stale. Run: npm run economics:concentration');
      process.exit(1);
    }
    console.log('Provider concentration report is up to date.');
    return;
  }
  await writeFile(paths.report, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, paths.report)} (${analysis.findings.length} findings).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
