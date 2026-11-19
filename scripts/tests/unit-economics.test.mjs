import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allocatePool,
  banded,
  computeUnitEconomics,
  renderUnitEconomicsReport,
  totalRequests,
  validateUnitEconomics,
} from '../unit-economics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function load() {
  const read = async (name) => JSON.parse(await readFile(path.join(root, 'config', name), 'utf8'));
  return {
    config: await read('unit-economics.json'),
    feeds: await read('feed-cost-quality.json'),
    sustainability: await read('sustainability-model.json'),
  };
}

const sum = (xs) => xs.reduce((s, v) => s + v, 0);

test('committed inputs are valid and match the document', async () => {
  const { config, feeds, sustainability } = await load();
  const result = computeUnitEconomics(config, feeds, sustainability);
  assert.deepEqual(result.errors, []);
  assert.equal(result.regions.length, 3);
  assert.equal(result.feeds.length, 5);
  const existing = await readFile(path.join(root, 'docs', 'REGIONAL_AND_FEED_UNIT_ECONOMICS.md'), 'utf8');
  assert.equal(existing.trim(), renderUnitEconomicsReport(config, result).trim());
});

test('both views attribute the whole cost pool and all revenue', async () => {
  const { config, feeds, sustainability } = await load();
  const result = computeUnitEconomics(config, feeds, sustainability);
  const { costPool, regionDirect, feedDirect, shared, revenueUsd } = result.totals;
  assert.ok(Math.abs(regionDirect + feedDirect + shared - costPool) < 0.011);
  assert.ok(Math.abs(sum(result.regions.map((r) => r.cost.point)) - costPool) < 0.02);
  assert.ok(Math.abs(sum(result.feeds.map((f) => f.cost.point)) - costPool) < 0.02);
  assert.ok(Math.abs(sum(result.regions.map((r) => r.revenue)) - revenueUsd) < 0.02);
  assert.ok(Math.abs(sum(result.feeds.map((f) => f.revenue)) - revenueUsd) < 0.02);
  assert.equal(totalRequests(sustainability), 22550000);
});

test('feed direct cost excludes compute and storage already counted regionally', async () => {
  const { config, feeds, sustainability } = await load();
  const result = computeUnitEconomics(config, feeds, sustainability);
  const btc = feeds.feeds.find((f) => f.feedId === 'btc-usd').costMetrics;
  const direct = result.feeds.find((f) => f.id === 'btc-usd').breakdown.filter((b) => b.kind === 'direct');
  assert.equal(sum(direct.map((d) => d.point)), btc.providerIngestionMonthlyUsd + btc.onChainGasMonthlyUsd);
});

test('every range is ordered low <= point <= high', async () => {
  const { config, feeds, sustainability } = await load();
  const result = computeUnitEconomics(config, feeds, sustainability);
  for (const row of [...result.regions, ...result.feeds]) {
    for (const r of [row.cost, row.margin, row.costPer1MRequests]) {
      assert.ok(r.low <= r.point && r.point <= r.high, `${row.id} range ordered`);
    }
    assert.ok(row.margin.lowPct <= row.margin.pointPct && row.margin.pointPct <= row.margin.highPct);
  }
});

test('allocation with one key and zero band collapses to a point', () => {
  const vectors = { requests: { a: 0.25, b: 0.75 }, even: { a: 0.5, b: 0.5 } };
  const single = allocatePool(banded(100, 0), 'requests', [], vectors);
  assert.deepEqual(single, { a: { point: 25, low: 25, high: 25 }, b: { point: 75, low: 75, high: 75 } });
  const ranged = allocatePool(banded(100, 10), 'requests', ['even'], vectors);
  assert.equal(ranged.a.point, 25);
  assert.equal(ranged.a.low, 22.5);
  assert.ok(Math.abs(ranged.a.high - 0.5 * 110) < 1e-9);
  assert.equal(ranged.b.low, 0.5 * 90);
  assert.ok(Math.abs(ranged.b.high - 0.75 * 110) < 1e-9);
});

test('a low margin floor breach fails the check', async () => {
  const { config, feeds, sustainability } = await load();
  const strict = structuredClone(config);
  strict.marginFloorPct = 96;
  const result = computeUnitEconomics(strict, feeds, sustainability);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /ap-southeast-1: low-case margin/);
});

test('invalid shares, keys and feed mismatches are rejected', async () => {
  const { config, feeds } = await load();
  const bad = structuredClone(config);
  bad.regions[0].revenueShare = 0.6;
  bad.feeds.requestsShare['sol-usd'] = 0;
  delete bad.feeds.requestsShare['usdt-usd'];
  bad.sharedCosts[0].regionKey = 'headcount';
  bad.sharedCosts[1].errorBandPct = 150;
  bad.crossAllocation.regionDirectToFeeds.key = 'vcpu';
  const errors = validateUnitEconomics(bad, feeds).join('\n');
  assert.match(errors, /region revenueShare: shares sum to 1\.080000/);
  assert.match(errors, /feed usdt-usd: missing from feeds\.requestsShare/);
  assert.match(errors, /feed sol-usd: not present/);
  assert.match(errors, /unknown region allocation key "headcount"/);
  assert.match(errors, /errorBandPct must be 0\.\.100/);
  assert.match(errors, /regionDirectToFeeds: unknown key "vcpu"/);
  assert.match(validateUnitEconomics({ regions: [], feeds: { requestsShare: {} } }, { feeds: [] }).join('\n'), /at least one region/);
});
