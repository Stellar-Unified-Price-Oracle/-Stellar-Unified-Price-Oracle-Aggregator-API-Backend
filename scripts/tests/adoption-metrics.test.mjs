import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildActivityLedger,
  computeAdoptionMetrics,
  createPseudonymizer,
  findIdentifierLeaks,
  generateSyntheticUsage,
  minimizeRecord,
  publishCount,
  renderReport,
  runAdoptionMetrics,
  suppressBreakdown,
  validateConfig,
  weekStart,
} from '../adoption-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const loadConfig = async () => JSON.parse(await readFile(path.join(root, 'config', 'adoption-metrics.json'), 'utf8'));
const SALT = 'unit-test-salt-that-is-long-enough-32+';
const MONDAY = Date.UTC(2026, 10, 2);
const WEEK = 7 * 24 * 60 * 60 * 1000;

const usage = (key, week, extra = {}) => ({ apiKeyPrefix: key, timestamp: MONDAY + week * WEEK + 3600_000, status: 200, asset: 'XLM', tier: 'pro', ...extra });
const keys = (n, prefix = 'key') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, '0')}`);

test('shipped config validates and forbids identifying input fields', async () => {
  const config = await loadConfig();
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, input: { ...config.input, allowedFields: [...config.input.allowedFields, 'ip'] } }), /must not include ip/);
  assert.throws(() => validateConfig({ ...config, metrics: [{ id: 'vanity', definition: 'x' }] }), /product decision/);
  assert.throws(() => validateConfig({ ...config, privacy: { ...config.privacy, minCohortSize: 1 } }), /minCohortSize/);
  assert.throws(() => validateConfig({ ...config, privacy: { ...config.privacy, rawEventRetentionDays: 90 } }), /rawEventRetentionDays/);
});

test('pseudonymizer requires a long salt and is stable per salt', async () => {
  const config = await loadConfig();
  assert.throws(() => createPseudonymizer(undefined, config), /ADOPTION_METRICS_SALT/);
  assert.throws(() => createPseudonymizer('short', config), /at least 32/);
  const a = createPseudonymizer(SALT, config);
  const b = createPseudonymizer(`${SALT}-rotated`, config);
  assert.equal(a('abcd1234'), a('abcd1234'));
  assert.notEqual(a('abcd1234'), b('abcd1234'));
  assert.equal(a('abcd1234').length, config.privacy.pseudonymHexLength);
  assert.ok(!a('abcd1234').includes('abcd1234'));
});

test('weekStart buckets to the UTC Monday', () => {
  assert.equal(weekStart(Date.UTC(2026, 10, 8, 23, 59)), MONDAY);
  assert.equal(weekStart(MONDAY), MONDAY);
  assert.equal(weekStart(Date.UTC(2026, 10, 9)), MONDAY + WEEK);
});

test('minimizeRecord drops non-allow-listed fields and rejects unusable records', async () => {
  const config = await loadConfig();
  const { record, dropped } = minimizeRecord({ ...usage('k1', 0), ip: '1.2.3.4', userAgent: 'x', endpoint: '/e' }, config);
  assert.deepEqual(dropped.sort(), ['endpoint', 'ip', 'userAgent']);
  assert.equal(record.ip, undefined);
  assert.equal(minimizeRecord({ apiKeyPrefix: 'k', timestamp: 'nope' }, config).record, null);
  assert.equal(minimizeRecord({ timestamp: 1 }, config).record, null);
});

test('ledger excludes anonymous, failed and invalid requests and holds no raw keys', async () => {
  const config = await loadConfig();
  const pseud = createPseudonymizer(SALT, config);
  const { ledger, stats } = buildActivityLedger(
    [usage('rawkey01', 0), usage('anonymous', 0), usage('rawkey02', 0, { status: 500 }), { junk: true }, usage('rawkey01', 1)],
    config,
    pseud,
  );
  assert.equal(ledger.size, 1);
  assert.equal(stats.anonymousRequests, 1);
  assert.equal(stats.inactiveStatusRequests, 1);
  assert.equal(stats.invalidRecords, 1);
  const [[p, entry]] = [...ledger.entries()];
  assert.equal(p, pseud('rawkey01'));
  assert.equal(entry.weeks.size, 2);
  assert.ok(!JSON.stringify([...ledger.keys()]).includes('rawkey01'));
});

test('publishCount suppresses below k and rounds at and above k', async () => {
  const { privacy } = await loadConfig();
  assert.equal(publishCount(privacy.minCohortSize - 1, privacy), null);
  assert.equal(publishCount(privacy.minCohortSize, privacy), 10);
  assert.equal(publishCount(12, privacy), 10);
  assert.equal(publishCount(13, privacy), 15);
});

test('complementary suppression hides the next-smallest cell when only one is small', async () => {
  const { privacy } = await loadConfig();
  const cells = suppressBreakdown({ free: 70, pro: 24, enterprise: 6 }, privacy);
  assert.deepEqual(cells.map((c) => [c.label, c.value]), [['free', 70], ['pro', null], ['enterprise', null]]);
  assert.equal(cells.find((c) => c.label === 'pro').complementary, true);
  const two = suppressBreakdown({ a: 3, b: 4, c: 50 }, privacy);
  assert.equal(two.filter((c) => c.complementary).length, 0);
  assert.equal(suppressBreakdown({ only: 3 }, privacy)[0].value, null);
});

test('population below k publishes nothing', async () => {
  const config = await loadConfig();
  const records = keys(config.privacy.minCohortSize - 1).map((k) => usage(k, 0));
  const { metrics } = runAdoptionMetrics(records, config, SALT);
  assert.deepEqual(metrics, { insufficientPopulation: true, minCohortSize: config.privacy.minCohortSize });
});

test('exactly k consumers are published, with weekly, cohort and retention figures', async () => {
  const config = await loadConfig();
  const cohort = keys(10);
  const records = [
    ...cohort.map((k) => usage(k, 0)),
    ...cohort.slice(0, 5).map((k) => usage(k, 1)),
    ...cohort.slice(0, 2).map((k) => usage(k, 4)),
  ];
  const { metrics } = runAdoptionMetrics(records, config, SALT);
  assert.equal(metrics.distinctConsumers, 10);
  assert.equal(metrics.weekly[0].activeConsumers, 10);
  assert.equal(metrics.weekly[1].activeConsumers, null);
  assert.equal(metrics.cohorts[0].retention.w1, 0.5);
  assert.equal(metrics.cohorts[0].retention.w4, 0.2);
  assert.equal(metrics.cohorts[0].retention.w12, null);
});

test('leak check finds raw keys and pseudonyms and the job refuses to publish them', async () => {
  const config = await loadConfig();
  const pseud = createPseudonymizer(SALT, config);
  assert.deepEqual(findIdentifierLeaks({ note: 'abcd1234 did it' }, ['abcd1234', 'zzzzzzzz']), ['abcd1234']);
  assert.deepEqual(findIdentifierLeaks({ asset: 'ABCD1234' }, ['abcd1234']), ['abcd1234']);
  assert.deepEqual(findIdentifierLeaks({ v: pseud('abcd1234') }, [pseud('abcd1234')]), [pseud('abcd1234')]);
  const records = keys(12).map((k) => usage(k, 0, { asset: k }));
  assert.throws(() => runAdoptionMetrics(records, config, SALT), /Refusing to publish/);
});

test('synthetic example publishes no identifiers and shows suppression', async () => {
  const config = await loadConfig();
  const records = generateSyntheticUsage();
  const result = runAdoptionMetrics(records, config, SALT);
  const text = JSON.stringify(result);
  assert.ok(!text.includes('203.0.113.'));
  assert.ok(!text.includes('synthetic-client'));
  assert.equal(result.stats.droppedFields.ip, records.filter((r) => r.ip).length);
  assert.ok(result.metrics.privacy.suppressedCells > 0);
  assert.ok(result.metrics.tierMix.some((c) => c.complementary));
  assert.equal(computeAdoptionMetrics(new Map(), config).insufficientPopulation, true);
});

test('generated document is up to date and documents rollout and rollback', async () => {
  const config = await loadConfig();
  const rendered = renderReport(config, runAdoptionMetrics(generateSyntheticUsage(), config, 'synthetic-fixture-salt-not-for-production-use'));
  const committed = await readFile(path.join(root, 'docs', 'ADOPTION_METRICS.md'), 'utf8');
  assert.equal(committed.trim(), rendered.trim(), 'run: npm run economics:adoption');
  for (const heading of ['## Metric catalog', '## Privacy safeguards', '## Compatibility, monitoring and operational impact', '## Rollout and rollback']) {
    assert.ok(rendered.includes(heading), heading);
  }
});
