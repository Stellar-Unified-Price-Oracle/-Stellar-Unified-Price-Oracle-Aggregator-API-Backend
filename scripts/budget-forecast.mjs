#!/usr/bin/env node

/**
 * scripts/budget-forecast.mjs — issue #793
 *
 * Extends the monthly budget forecast with confidence ranges (seeded Monte Carlo over
 * triangular driver distributions), one-at-a-time sensitivity drivers, and variance
 * tracking of recorded cloud (config/cost-invoices.json) and network (Soroban) actuals
 * against the forecast band. Generates docs/BUDGET_FORECAST_UNCERTAINTY.md.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forecastPath = path.join(root, 'config', 'budget-forecast.json');
const costModelPath = path.join(root, 'config', 'cost-model.json');
const invoicesPath = path.join(root, 'config', 'cost-invoices.json');
const reportPath = path.join(root, 'docs', 'BUDGET_FORECAST_UNCERTAINTY.md');

const CATEGORIES = ['cloud', 'network'];

export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleTriangular(low, mode, high, u) {
  if (high === low) return mode;
  const c = (mode - low) / (high - low);
  return u < c ? low + Math.sqrt(u * (high - low) * (mode - low)) : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
}

export function percentile(sorted, p) {
  if (sorted.length === 0) throw new Error('percentile of an empty sample');
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function validateDrivers(drivers) {
  const errors = [];
  if (!Array.isArray(drivers) || drivers.length === 0) return ['at least one driver is required'];
  const fx = drivers.filter((d) => d.role === 'fx');
  if (fx.length > 1) errors.push('at most one fx driver is allowed');
  const ids = new Set();
  for (const d of drivers) {
    if (ids.has(d.id)) errors.push(`duplicate driver id "${d.id}"`);
    ids.add(d.id);
    if (![d.low, d.mode, d.high].every((v) => Number.isFinite(v) && v >= 0)) {
      errors.push(`driver "${d.id}": low, mode and high must be non-negative numbers`);
    } else if (!(d.low <= d.mode && d.mode <= d.high)) {
      errors.push(`driver "${d.id}": requires low <= mode <= high (got ${d.low}, ${d.mode}, ${d.high})`);
    }
    if (d.role === 'fx') continue;
    if (!CATEGORIES.includes(d.category)) errors.push(`driver "${d.id}": unknown category "${d.category}"`);
    if (!d.unitCost) errors.push(`driver "${d.id}": unitCost is required`);
    if (d.unitCost?.xlm != null && fx.length === 0) errors.push(`driver "${d.id}": XLM-priced driver needs an fx driver`);
  }
  return errors;
}

export function resolveUnitCosts(drivers, costModel) {
  return drivers.map((d) => {
    if (d.role === 'fx') return { ...d, usdPerUnit: null };
    const uc = d.unitCost;
    if (uc.from === 'cost-model') {
      const rate = costModel?.rates?.[uc.rate];
      if (!Number.isFinite(rate)) throw new Error(`driver "${d.id}": cost-model rate "${uc.rate}" not found`);
      return { ...d, usdPerUnit: rate * (uc.perHour ? costModel.hoursPerMonth : 1) };
    }
    if (Number.isFinite(uc.fixedUsd)) return { ...d, usdPerUnit: uc.fixedUsd };
    if (Number.isFinite(uc.xlm)) return { ...d, xlmPerUnit: uc.xlm, usdPerUnit: null };
    throw new Error(`driver "${d.id}": unitCost must reference the cost model, fixedUsd or xlm`);
  });
}

export function costForValues(drivers, values) {
  const fxDriver = drivers.find((d) => d.role === 'fx');
  const fx = fxDriver ? values[fxDriver.id] : 0;
  const totals = { cloud: 0, network: 0 };
  for (const d of drivers) {
    if (d.role === 'fx') continue;
    const usd = d.xlmPerUnit != null ? values[d.id] * d.xlmPerUnit * fx : values[d.id] * d.usdPerUnit;
    totals[d.category] += usd;
  }
  return { ...totals, total: totals.cloud + totals.network };
}

function modeValues(drivers) {
  return Object.fromEntries(drivers.map((d) => [d.id, d.mode]));
}

export function simulateForecast(drivers, { iterations, seed, confidenceLevels }) {
  if (!(iterations >= 1)) throw new Error('iterations must be >= 1');
  const rng = createRng(seed);
  const samples = { cloud: [], network: [], total: [] };
  for (let i = 0; i < iterations; i++) {
    const values = {};
    for (const d of drivers) values[d.id] = sampleTriangular(d.low, d.mode, d.high, rng());
    const cost = costForValues(drivers, values);
    samples.cloud.push(cost.cloud);
    samples.network.push(cost.network);
    samples.total.push(cost.total);
  }
  const point = costForValues(drivers, modeValues(drivers));
  const bands = {};
  for (const key of ['cloud', 'network', 'total']) {
    const sorted = samples[key].sort((a, b) => a - b);
    bands[key] = {
      point: round(point[key]),
      mean: round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
      ...Object.fromEntries(confidenceLevels.map((p) => [`p${Math.round(p * 100)}`, round(percentile(sorted, p))])),
    };
  }
  return bands;
}

export function sensitivity(drivers) {
  const base = modeValues(drivers);
  const baseTotal = costForValues(drivers, base).total;
  const rows = drivers.map((d) => {
    const low = costForValues(drivers, { ...base, [d.id]: d.low }).total;
    const high = costForValues(drivers, { ...base, [d.id]: d.high }).total;
    return {
      id: d.id,
      label: d.label,
      category: d.role === 'fx' ? 'network' : d.category,
      totalAtLow: round(low),
      totalAtHigh: round(high),
      downsideUsd: round(low - baseTotal),
      upsideUsd: round(high - baseTotal),
      swingUsd: round(Math.abs(high - low)),
    };
  });
  const totalSwing = rows.reduce((s, r) => s + r.swingUsd, 0);
  return rows
    .map((r) => ({ ...r, swingSharePct: totalSwing > 0 ? round((r.swingUsd / totalSwing) * 100, 1) : 0 }))
    .sort((a, b) => b.swingUsd - a.swingUsd || a.id.localeCompare(b.id));
}

export function collectActuals(invoices, networkActuals) {
  const months = new Map();
  for (const inv of invoices ?? []) {
    months.set(inv.month, { month: inv.month, cloud: inv.invoicedTotal, network: null });
  }
  for (const n of networkActuals ?? []) {
    if (!(n.xlmSpent >= 0) || !(n.avgXlmUsd > 0)) throw new Error(`network actual ${n.month}: invalid xlmSpent or avgXlmUsd`);
    const entry = months.get(n.month) ?? { month: n.month, cloud: null, network: null };
    entry.network = round(n.xlmSpent * n.avgXlmUsd);
    months.set(n.month, entry);
  }
  return [...months.values()]
    .map((m) => ({ ...m, total: m.cloud != null && m.network != null ? round(m.cloud + m.network) : null }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export function classifyVariance(actual, band, tolerancePct) {
  if (actual == null) return null;
  const variancePct = band.p50 === 0 ? 0 : ((actual - band.p50) / band.p50) * 100;
  const withinBand = actual >= band.p10 && actual <= band.p90;
  const breach = Math.abs(variancePct) > tolerancePct;
  return {
    actual,
    forecastP50: band.p50,
    varianceUsd: round(actual - band.p50),
    variancePct: round(variancePct, 1),
    withinBand,
    status: breach ? 'tolerance-breach' : withinBand ? 'within-band' : 'outside-band',
  };
}

export function trackVariance(actuals, bands, tolerancePct) {
  const rows = actuals.map((m) => ({
    month: m.month,
    cloud: classifyVariance(m.cloud, bands.cloud, tolerancePct.cloud),
    network: classifyVariance(m.network, bands.network, tolerancePct.network),
    total: classifyVariance(m.total, bands.total, tolerancePct.total),
  }));
  const observations = rows.flatMap((r) => ['cloud', 'network'].map((k) => r[k]).filter(Boolean));
  const inBand = observations.filter((o) => o.withinBand).length;
  const breaches = rows.flatMap((r) =>
    ['cloud', 'network', 'total'].filter((k) => r[k]?.status === 'tolerance-breach').map((k) => `${r.month} ${k}`),
  );
  return {
    rows,
    calibration: {
      observations: observations.length,
      withinBand: inBand,
      coveragePct: observations.length > 0 ? round((inBand / observations.length) * 100, 1) : null,
      expectedCoveragePct: 80,
    },
    breaches,
  };
}

export function runBudgetForecast(forecast, costModel, invoices) {
  const errors = validateDrivers(forecast?.drivers);
  if (errors.length > 0) return { valid: false, errors };
  const drivers = resolveUnitCosts(forecast.drivers, costModel);
  const bands = simulateForecast(drivers, forecast.simulation);
  const ranking = sensitivity(drivers);
  const variance = trackVariance(collectActuals(invoices, forecast.networkActuals), bands, forecast.varianceTolerancePct);
  return { valid: variance.breaches.length === 0, errors: variance.breaches.map((b) => `variance tolerance breached: ${b}`), drivers, bands, ranking, variance };
}

function round(v, digits = 2) {
  return Number(v.toFixed(digits));
}

function money(v) {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function signed(v) {
  return v > 0 ? `+${money(v)}` : money(v);
}

function varianceCell(v) {
  if (!v) return '—';
  const label = { 'within-band': 'within band', 'outside-band': 'outside band', 'tolerance-breach': '**tolerance breach**' }[v.status];
  return `${money(v.actual)} (${v.variancePct > 0 ? '+' : ''}${v.variancePct}%, ${label})`;
}

export function renderForecastReport(forecast, result) {
  const { bands, ranking, variance, drivers } = result;
  const sim = forecast.simulation;
  const cal = variance.calibration;
  return `# Budget Forecast Uncertainty (Issue #793)

The monthly budget forecast is reported as a confidence range rather than a single number,
with the drivers that move it ranked by impact and every recorded month tracked against the
range. Generated from \`config/budget-forecast.json\`, \`config/cost-model.json\` and
\`config/cost-invoices.json\` by \`npm run budget:forecast\`; do not edit by hand.

- **Owner**: ${forecast.owner}
- **Last updated**: ${forecast.updatedAt} · **Review interval**: ${forecast.reviewIntervalDays} days · **Next review**: ${forecast.nextReviewDate}

## Confidence ranges (monthly, ${forecast.currency})

| Category | Point (all drivers at mode) | Mean | P10 | P50 | P90 | P90 − P10 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
${['cloud', 'network', 'total']
  .map((k) => {
    const b = bands[k];
    const name = k === 'total' ? '**Total**' : k === 'cloud' ? 'Cloud (compute, storage, egress, control plane)' : 'Network (Soroban fees and rent)';
    return `| ${name} | ${money(b.point)} | ${money(b.mean)} | ${money(b.p10)} | ${money(b.p50)} | ${money(b.p90)} | ${money(b.p90 - b.p10)} |`;
  })
  .join('\n')}

Method: each driver is a triangular distribution (low, mode, high). ${sim.iterations.toLocaleString('en-US')} draws with
seed ${sim.seed} make the result reproducible, so the same inputs always produce this document.
Percentiles are computed per category from the simulated totals, so the total P10/P90 is
narrower than the sum of the category P10/P90s.

## Drivers

| Driver | Category | Unit | Low | Mode | High | Unit cost | Rationale |
| :--- | :--- | :--- | ---: | ---: | ---: | :--- | :--- |
${drivers
  .map((d) => {
    const unitCost = d.role === 'fx' ? 'converts XLM costs' : d.xlmPerUnit != null ? `${d.xlmPerUnit} XLM` : `${money(d.usdPerUnit)}`;
    return `| ${d.label} | ${d.role === 'fx' ? 'network (fx)' : d.category} | ${d.unit} | ${d.low} | ${d.mode} | ${d.high} | ${unitCost} | ${d.rationale} |`;
  })
  .join('\n')}

## Sensitivity drivers

Each driver is moved to its low and high value while every other driver stays at its mode.
Drivers are ranked by the resulting swing in the total monthly forecast.

| Rank | Driver | Total at low | Total at high | Downside | Upside | Swing | Share of swing |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
${ranking
  .map(
    (r, i) =>
      `| ${i + 1} | ${r.label} | ${money(r.totalAtLow)} | ${money(r.totalAtHigh)} | ${signed(r.downsideUsd)} | ${signed(r.upsideUsd)} | ${money(r.swingUsd)} | ${r.swingSharePct}% |`,
  )
  .join('\n')}

## Variance against actual costs

Cloud actuals are the invoiced totals in \`config/cost-invoices.json\`; network actuals are XLM
spent by the oracle account converted at the month's average XLM/USD rate. Variance is measured
against the forecast P50. Tolerances: cloud ±${forecast.varianceTolerancePct.cloud}%, network ±${forecast.varianceTolerancePct.network}%, total ±${forecast.varianceTolerancePct.total}%.

| Month | Cloud | Network | Total |
| :--- | :--- | :--- | :--- |
${variance.rows.map((r) => `| ${r.month} | ${varianceCell(r.cloud)} | ${varianceCell(r.network)} | ${varianceCell(r.total)} |`).join('\n')}

**Calibration**: ${cal.withinBand} of ${cal.observations} category observations fall inside the P10–P90 band
(${cal.coveragePct ?? 'n/a'}% observed vs ${cal.expectedCoveragePct}% expected). Persistent under-coverage on one side
means the driver ranges are biased and must be re-centred at the next review.

- **within band**: actual is between P10 and P90.
- **outside band**: actual is outside P10–P90 but within tolerance; review the driver ranges.
- **tolerance breach**: variance exceeds tolerance; \`npm run budget:forecast:check\` fails until the
  forecast is revised or the variance is explained in the review notes.

## Review procedure and completion evidence

1. Each month, append the invoice to \`config/cost-invoices.json\` and the oracle account's XLM
   spend to \`networkActuals\` in \`config/budget-forecast.json\`.
2. Run \`npm run budget:forecast\` and commit the regenerated document.
3. At each review, re-centre any driver whose actuals sit consistently on one side of the band.

\`npm run budget:forecast:check\` (run in CI) fails on invalid drivers, a tolerance breach or a stale
document. \`scripts/tests/budget-forecast.test.mjs\` covers the sampler, percentile maths,
degenerate (zero-width) ranges, sensitivity ranking, variance classification and invalid inputs.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. Reuses rates from \`config/cost-model.json\` and invoices from
  \`config/cost-invoices.json\` without changing them; \`npm run cost:reconcile\` and \`cost:check\` are
  unaffected.
- **Monitoring**: The XLM/USD rate and Soroban rent are the largest swing drivers; the existing
  rent budget (docs/RENT_BUDGET.md) and the oracle account balance alerts remain the runtime
  signals.
- **Operational impact**: None. Offline report; no runtime service reads these files.

## Rollout and rollback

- **Rollout**: Merge, then add actuals monthly as described above.
- **Rollback**: Revert the commit. No services, schemas or deployed resources depend on it.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const [forecast, costModel, invoiceFile] = await Promise.all(
    [forecastPath, costModelPath, invoicesPath].map(async (p) => JSON.parse(await readFile(p, 'utf8'))),
  );
  const result = runBudgetForecast(forecast, costModel, invoiceFile.invoices);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.bands) {
    for (const err of result.errors) console.error(`BUDGET_FORECAST_INVALID ${err}`);
    process.exit(1);
  }

  const rendered = renderForecastReport(forecast, result);

  if (args.includes('--check')) {
    let failed = false;
    for (const err of result.errors) {
      console.error(`BUDGET_FORECAST_VARIANCE ${err}`);
      failed = true;
    }
    let existing = '';
    try {
      existing = await readFile(reportPath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/BUDGET_FORECAST_UNCERTAINTY.md is stale. Run: npm run budget:forecast');
      failed = true;
    }
    if (failed) process.exit(1);
    console.log('Budget forecast is within tolerance and the document is up to date.');
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  const t = result.bands.total;
  console.log(`Generated ${path.relative(root, reportPath)}: total P10 ${money(t.p10)} / P50 ${money(t.p50)} / P90 ${money(t.p90)}.`);
  for (const err of result.errors) console.warn(`warning: ${err}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
