import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyVariance,
  collectActuals,
  createRng,
  percentile,
  renderForecastReport,
  resolveUnitCosts,
  runBudgetForecast,
  sampleTriangular,
  sensitivity,
  simulateForecast,
  validateDrivers,
} from '../budget-forecast.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function load() {
  const read = async (name) => JSON.parse(await readFile(path.join(root, 'config', name), 'utf8'));
  return {
    forecast: await read('budget-forecast.json'),
    costModel: await read('cost-model.json'),
    invoices: (await read('cost-invoices.json')).invoices,
  };
}

const SIM = { iterations: 2000, seed: 1, confidenceLevels: [0.1, 0.5, 0.9] };

test('committed forecast is valid, ordered and matches the document', async () => {
  const { forecast, costModel, invoices } = await load();
  const result = runBudgetForecast(forecast, costModel, invoices);
  assert.deepEqual(result.errors, []);
  for (const key of ['cloud', 'network', 'total']) {
    const b = result.bands[key];
    assert.ok(b.p10 <= b.p50 && b.p50 <= b.p90, `${key} percentiles ordered`);
  }
  const existing = await readFile(path.join(root, 'docs', 'BUDGET_FORECAST_UNCERTAINTY.md'), 'utf8');
  assert.equal(existing.trim(), renderForecastReport(forecast, result).trim());
});

test('point forecast at mode reproduces the cost-model optimized run rate', async () => {
  const { forecast, costModel } = await load();
  const drivers = resolveUnitCosts(forecast.drivers, costModel);
  const bands = simulateForecast(drivers, SIM);
  const computeMemoryStorage = 0.625 * 0.04 * 730 + 1.4375 * 0.005 * 730 + 10 * 0.17;
  assert.equal(computeMemoryStorage.toFixed(2), '25.20');
  assert.equal(bands.cloud.point, Number((computeMemoryStorage + 12.5 * 0.09 + 1).toFixed(2)));
  assert.equal(bands.network.point, Number(((432000 * 0.00015 + 500) * 0.12).toFixed(2)));
});

test('simulation is deterministic for a fixed seed', async () => {
  const { forecast, costModel } = await load();
  const drivers = resolveUnitCosts(forecast.drivers, costModel);
  assert.deepEqual(simulateForecast(drivers, SIM), simulateForecast(drivers, SIM));
  assert.notDeepEqual(simulateForecast(drivers, SIM), simulateForecast(drivers, { ...SIM, seed: 2 }));
});

test('triangular sampler stays within bounds and hits the edges', () => {
  const rng = createRng(42);
  for (let i = 0; i < 1000; i++) {
    const v = sampleTriangular(2, 3, 10, rng());
    assert.ok(v >= 2 && v <= 10);
  }
  assert.equal(sampleTriangular(2, 3, 10, 0), 2);
  assert.equal(sampleTriangular(2, 3, 10, 1), 10);
  assert.equal(sampleTriangular(5, 5, 5, 0.7), 5);
});

test('percentile interpolates and rejects empty samples', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([0, 10], 0.1), 1);
  assert.equal(percentile([7], 0.9), 7);
  assert.throws(() => percentile([], 0.5), /empty sample/);
});

test('zero-width driver ranges collapse the confidence band to the point estimate', () => {
  const drivers = resolveUnitCosts(
    [
      { id: 'a', category: 'cloud', low: 2, mode: 2, high: 2, unitCost: { fixedUsd: 10 } },
      { id: 'b', category: 'network', low: 100, mode: 100, high: 100, unitCost: { xlm: 1 } },
      { id: 'fx', role: 'fx', low: 0.1, mode: 0.1, high: 0.1 },
    ],
    {},
  );
  const bands = simulateForecast(drivers, SIM);
  assert.deepEqual(bands.total, { point: 30, mean: 30, p10: 30, p50: 30, p90: 30 });
});

test('sensitivity ranks the widest driver first and shares sum to 100%', async () => {
  const { forecast, costModel } = await load();
  const ranking = sensitivity(resolveUnitCosts(forecast.drivers, costModel));
  assert.equal(ranking[0].id, 'xlm-usd');
  for (let i = 1; i < ranking.length; i++) assert.ok(ranking[i - 1].swingUsd >= ranking[i].swingUsd);
  const share = ranking.reduce((s, r) => s + r.swingSharePct, 0);
  assert.ok(Math.abs(share - 100) < 0.5);
});

test('variance classification covers band edges and tolerance breaches', () => {
  const band = { p10: 90, p50: 100, p90: 120 };
  assert.equal(classifyVariance(90, band, 15).status, 'within-band');
  assert.equal(classifyVariance(120, band, 25).status, 'within-band');
  assert.equal(classifyVariance(89, band, 15).status, 'outside-band');
  assert.equal(classifyVariance(115.01, { ...band, p90: 110 }, 15).status, 'tolerance-breach');
  assert.equal(classifyVariance(null, band, 15), null);
  assert.equal(classifyVariance(80, band, 15).variancePct, -20);
});

test('actuals merge invoice and network months and compute totals only when both exist', () => {
  const actuals = collectActuals(
    [{ month: '2026-08', invoicedTotal: 20 }],
    [
      { month: '2026-08', xlmSpent: 100, avgXlmUsd: 0.1 },
      { month: '2026-09', xlmSpent: 50, avgXlmUsd: 0.2 },
    ],
  );
  assert.deepEqual(actuals, [
    { month: '2026-08', cloud: 20, network: 10, total: 30 },
    { month: '2026-09', cloud: null, network: 10, total: null },
  ]);
  assert.throws(() => collectActuals([], [{ month: '2026-09', xlmSpent: 1, avgXlmUsd: 0 }]), /invalid/);
});

test('a large actual overrun fails the forecast', async () => {
  const { forecast, costModel, invoices } = await load();
  const overrun = structuredClone(forecast);
  overrun.networkActuals.push({ month: '2026-11', xlmSpent: 2000, avgXlmUsd: 0.2 });
  const result = runBudgetForecast(overrun, costModel, invoices);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /2026-11 network/);
});

test('invalid drivers are rejected', () => {
  assert.deepEqual(validateDrivers([]), ['at least one driver is required']);
  const errors = validateDrivers([
    { id: 'a', category: 'cloud', low: 5, mode: 2, high: 3, unitCost: { fixedUsd: 1 } },
    { id: 'a', category: 'other', low: -1, mode: 0, high: 1, unitCost: { fixedUsd: 1 } },
    { id: 'c', category: 'network', low: 1, mode: 1, high: 1, unitCost: { xlm: 1 } },
  ]).join('\n');
  assert.match(errors, /low <= mode <= high/);
  assert.match(errors, /duplicate driver id "a"/);
  assert.match(errors, /non-negative/);
  assert.match(errors, /unknown category "other"/);
  assert.match(errors, /needs an fx driver/);
  assert.throws(
    () => resolveUnitCosts([{ id: 'x', category: 'cloud', unitCost: { from: 'cost-model', rate: 'nope' } }], { rates: {} }),
    /not found/,
  );
});
