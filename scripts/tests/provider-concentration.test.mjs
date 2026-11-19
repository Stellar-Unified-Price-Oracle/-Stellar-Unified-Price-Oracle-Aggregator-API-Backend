import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeFeeds,
  alternativeAnnualCost,
  analyzeConcentration,
  classifyHhi,
  collusionThreshold,
  concentrationMetrics,
  expectedDowntime,
  loadInputs,
  renderReport,
  withAlternatives,
} from '../provider-concentration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const feed = (feedId, sources) => ({
  feedId,
  lifecycle: { state: 'active' },
  eligibleSources: sources.map(([source, weightBps, required = false]) => ({ source, weightBps, required })),
});

function miniConfig(overrides = {}) {
  return {
    owner: 'test-owner',
    policy: {
      quorumMinSources: 3, hhiModerate: 1500, hhiHigh: 2500, targetFeedHhi: 2000,
      maxProviderSpendSharePct: 35, maxHostingGroupWeightSharePct: 50, slaCreditMultiplier: 0.5, amortizationMonths: 36,
    },
    providers: {
      a: { monthlyCostUsd: 10, hostingDependency: 'g1', expectedOutageHoursPerYear: 1 },
      b: { monthlyCostUsd: 10, hostingDependency: 'g2', expectedOutageHoursPerYear: 1 },
      c: { monthlyCostUsd: 10, hostingDependency: 'g2', expectedOutageHoursPerYear: 1 },
      d: { monthlyCostUsd: 10, hostingDependency: 'g3', expectedOutageHoursPerYear: 1 },
    },
    hostingDependencyOutageHoursPerYear: { g1: 0, g2: 5, g3: 0 },
    alternatives: [],
    ...overrides,
  };
}

test('HHI classes follow the configured bands', () => {
  const policy = { hhiModerate: 1500, hhiHigh: 2500 };
  assert.equal(classifyHhi(1499, policy), 'low');
  assert.equal(classifyHhi(1500, policy), 'moderate');
  assert.equal(classifyHhi(2500, policy), 'high');
});

test('activeFeeds ignores non-active feeds and fails on an empty catalog', () => {
  const catalog = { feeds: [feed('x', [['a', 1]]), { ...feed('y', [['a', 1]]), lifecycle: { state: 'retired' } }] };
  assert.deepEqual(activeFeeds(catalog).map((f) => f.feedId), ['x']);
  assert.throws(() => activeFeeds({ feeds: [] }), /no active feeds/);
});

test('equal weights over four providers give HHI 2500 and four effective providers', () => {
  const feeds = activeFeeds({ feeds: [feed('x', [['a', 1], ['b', 1], ['c', 1], ['d', 1]])] });
  const m = concentrationMetrics(miniConfig(), feeds);
  assert.equal(m.perFeed[0].hhi, 2500);
  assert.equal(m.perFeed[0].effectiveProviders, 4);
  assert.equal(m.perFeed[0].maxHostingGroup, 'g2');
  assert.equal(m.perFeed[0].maxHostingGroupShare, 0.5);
});

test('single-provider feed is a monopoly', () => {
  const feeds = activeFeeds({ feeds: [feed('solo', [['a', 10000, true]])] });
  const m = concentrationMetrics(miniConfig(), feeds);
  assert.equal(m.perFeed[0].hhi, 10000);
  assert.deepEqual(m.perFeed[0].required, ['a']);
});

test('a shared hosting outage that leaves fewer than quorum sources blocks the feed', () => {
  const feeds = activeFeeds({ feeds: [feed('x', [['a', 1], ['b', 1], ['c', 1], ['d', 1]])] });
  const runtime = expectedDowntime(miniConfig(), feeds, { enforceRequired: false });
  assert.equal(runtime.feedHours, 5);
  assert.deepEqual(runtime.blocking.map((b) => b.event), ['hosting:g2']);

  const expanded = withAlternatives(feeds, [{ id: 'e', weightBps: 1, hostingDependency: 'g4', expectedOutageHoursPerYear: 1 }]);
  const after = expectedDowntime(miniConfig(), expanded, { extra: [{ id: 'e', hostingDependency: 'g4', expectedOutageHoursPerYear: 1 }], enforceRequired: false });
  assert.equal(after.feedHours, 0);
});

test('an enforced required source turns its own outage into downtime', () => {
  const feeds = activeFeeds({ feeds: [feed('x', [['a', 1, true], ['b', 1], ['c', 1], ['d', 1]])] });
  const config = miniConfig({ hostingDependencyOutageHoursPerYear: { g1: 0, g2: 0, g3: 0 } });
  assert.equal(expectedDowntime(config, feeds, { enforceRequired: false }).feedHours, 0);
  assert.equal(expectedDowntime(config, feeds, { enforceRequired: true }).feedHours, 1);
});

test('alternative cost amortizes integration and includes ops time', () => {
  const cost = alternativeAnnualCost(miniConfig(), { monthlyCostUsd: 10, opsHoursMonthly: 1, opsHourlyUsd: 50, integrationOneOffUsd: 3600 });
  assert.equal(cost.recurringUsd, 720);
  assert.equal(cost.amortizedIntegrationUsd, 1200);
  assert.equal(cost.totalUsd, 1920);
});

test('collusion threshold is the smallest coalition that moves the median', () => {
  assert.equal(collusionThreshold(4), 2);
  assert.equal(collusionThreshold(5), 3);
  assert.equal(collusionThreshold(6), 3);
});

test('analysis rejects catalog sources without provider metadata', async () => {
  const inputs = await loadInputs();
  const { reflector: _dropped, ...providers } = inputs.config.providers;
  assert.throws(() => analyzeConcentration({ ...inputs, config: { ...inputs.config, providers } }), /reflector .* has no entry/);
});

test('shipped inputs reproduce the documented exposure and remediation', async () => {
  const a = analyzeConcentration(await loadInputs());
  assert.equal(a.providerSpendUsd, a.ingestionUsd, 'provider spend must reconcile with feed-cost-quality');
  assert.ok(a.current.perFeed.every((f) => f.required.includes('chainlink')));
  assert.ok(a.downtimeDeclared.feedHours > a.downtimeRuntime.feedHours);
  assert.deepEqual(a.downtimeRuntime.blocking.map((b) => b.event), ['hosting:shared-cloud-region']);
  assert.ok(a.current.fleetHhi >= 2500);
  assert.ok(a.recommended, 'a portfolio should meet the target');
  assert.ok(a.recommended.fleetHhi <= a.config.policy.targetFeedHhi);
  assert.equal(a.recommended.runtimeFeedHours, 0);
  const cheaper = a.portfolios.filter((p) => p.meetsTarget && p.annualCostUsd < a.recommended.annualCostUsd);
  assert.equal(cheaper.length, 0);
});

test('generated report is up to date and documents rollout and rollback', async () => {
  const rendered = renderReport(analyzeConcentration(await loadInputs()));
  const committed = await readFile(path.join(root, 'docs', 'PROVIDER_CONCENTRATION_REPORT.md'), 'utf8');
  assert.equal(committed.trim(), rendered.trim(), 'run: npm run economics:concentration');
  for (const heading of ['## Findings', '## Cost of independent alternatives', '## Compatibility, monitoring and operational impact', '## Rollout and rollback']) {
    assert.ok(rendered.includes(heading), heading);
  }
});
