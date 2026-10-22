import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateRevenue,
  calculateOperatingCosts,
  calculateReserveRequirements,
  runSustainabilityAnalysis,
  renderReport,
} from '../sustainability-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(root, 'config', 'sustainability-model.json');

async function loadTestModel() {
  const content = await readFile(configPath, 'utf8');
  return JSON.parse(content);
}

test('calculateRevenue computes correct tier totals and overages under baseline demand', async () => {
  const model = await loadTestModel();
  const result = calculateRevenue(model, 1.0);

  assert.ok(result.totalMonthlyRevenueUsd > 0);
  assert.equal(result.annualizedRevenueUsd, Number((result.totalMonthlyRevenueUsd * 12).toFixed(2)));

  // Free tier has 0 base and 0 overage
  assert.equal(result.tierBreakdown.free.baseRevenueMonthlyUsd, 0);
  assert.equal(result.tierBreakdown.free.overageRevenueMonthlyUsd, 0);

  // Pro tier (35 keys * $120 = $4200 base; 250k - 100k = 150k overage * 0.20/1k * 35 = $1050)
  assert.equal(result.tierBreakdown.pro.baseRevenueMonthlyUsd, 4200.0);
  assert.equal(result.tierBreakdown.pro.overageRevenueMonthlyUsd, 1050.0);
  assert.equal(result.tierBreakdown.pro.totalRevenueMonthlyUsd, 5250.0);

  // Enterprise tier (6 keys * $1250 = $7500 base; 2M - 1M = 1M overage * 0.15/1k * 6 = $900)
  assert.equal(result.tierBreakdown.enterprise.baseRevenueMonthlyUsd, 7500.0);
  assert.equal(result.tierBreakdown.enterprise.overageRevenueMonthlyUsd, 900.0);
  assert.equal(result.tierBreakdown.enterprise.totalRevenueMonthlyUsd, 8400.0);

  // Total baseline revenue: 5250 + 8400 = 13650
  assert.equal(result.totalMonthlyRevenueUsd, 13650.0);
});

test('calculateOperatingCosts includes all infrastructure, storage, gas, and provider layers', async () => {
  const model = await loadTestModel();
  const baseline = calculateOperatingCosts(model, 1.0);

  assert.ok(baseline.totalMonthlyCostUsd > 0);
  assert.equal(baseline.breakdown.kubernetesComputeMonthlyUsd, 25.2);
  assert.equal(baseline.breakdown.timescaleDbStorageMonthlyUsd, 8.91);
  assert.equal(baseline.breakdown.onChainSorobanMonthlyUsd, 67.82);
  assert.equal(baseline.breakdown.externalDataProvidersMonthlyUsd, 150.0);
  assert.equal(baseline.breakdown.observabilityToolingMonthlyUsd, 45.0);

  // Variable compute & gas scale up under demand surge
  const surge = calculateOperatingCosts(model, 3.0);
  assert.ok(surge.totalMonthlyCostUsd > baseline.totalMonthlyCostUsd);
  assert.ok(surge.breakdown.kubernetesComputeMonthlyUsd > baseline.breakdown.kubernetesComputeMonthlyUsd);
  assert.ok(surge.breakdown.onChainSorobanMonthlyUsd > baseline.breakdown.onChainSorobanMonthlyUsd);
});

test('calculateReserveRequirements enforces 6-month runway and multi-layer capital buffers', async () => {
  const model = await loadTestModel();
  const reserves = calculateReserveRequirements(model, 300.0);

  assert.equal(reserves.targetRunwayMonths, 6);
  assert.equal(reserves.baseOpexReserveUsd, 1800.0); // 300 * 6
  assert.equal(reserves.opexSafetyBufferUsd, 900.0); // 50% of 1800
  // On-chain gas buffer: 10,000 XLM * 0.12 = 1200 USD
  assert.equal(reserves.onChainGasBufferUsd, 1200.0);
  // Total capital reserve covers OpEx + safety + gas + contingency
  assert.ok(reserves.totalCapitalReserveRequiredUsd > 3900.0);
});

test('runSustainabilityAnalysis evaluates all sensitivity scenarios deterministically', async () => {
  const model = await loadTestModel();
  const analysis = runSustainabilityAnalysis(model);

  const scenarioKeys = ['trough', 'conservative', 'baseline', 'growth', 'surge', 'stress'];
  for (const key of scenarioKeys) {
    assert.ok(analysis.scenarios[key], `Scenario ${key} should be defined`);
    assert.ok(analysis.scenarios[key].monthlyNetMarginUsd > 0, `Scenario ${key} should maintain positive net margin`);
    assert.ok(analysis.scenarios[key].runwayMonths >= 6.0, `Scenario ${key} should have at least 6 months runway`);
  }

  // Trough revenue < Baseline revenue < Stress revenue
  assert.ok(analysis.scenarios.trough.revenue.totalMonthlyRevenueUsd < analysis.baseline.revenue.totalMonthlyRevenueUsd);
  assert.ok(analysis.scenarios.stress.revenue.totalMonthlyRevenueUsd > analysis.baseline.revenue.totalMonthlyRevenueUsd);
});

test('boundary conditions: demandMultiplier = 0 handles zero traffic safely', async () => {
  const model = await loadTestModel();
  const zeroDemandRev = calculateRevenue(model, 0);

  // Even at 0 queries, base monthly subscriptions (Pro & Enterprise) are collected
  assert.equal(zeroDemandRev.tierBreakdown.pro.overageRevenueMonthlyUsd, 0);
  assert.equal(zeroDemandRev.tierBreakdown.enterprise.overageRevenueMonthlyUsd, 0);
  assert.equal(zeroDemandRev.totalMonthlyRevenueUsd, 4200 + 7500); // 11700
});

test('failure conditions: negative or invalid inputs throw actionable errors', async () => {
  const model = await loadTestModel();

  assert.throws(() => calculateRevenue(model, -1), /Invalid demand multiplier/);
  assert.throws(() => calculateRevenue(model, Number.NaN), /Invalid demand multiplier/);
  assert.throws(() => calculateOperatingCosts(model, -0.5), /Invalid demand multiplier/);
  assert.throws(() => calculateReserveRequirements(model, -100), /Invalid monthly operating cost/);
});

test('renderReport includes all governance, owner, scope, and operational impact sections', async () => {
  const model = await loadTestModel();
  const analysis = runSustainabilityAnalysis(model);
  const markdown = renderReport(analysis);

  assert.ok(markdown.includes('# Post-GA Sustainability Model (Issue #786)'));
  assert.ok(markdown.includes('## Executive Summary & Financial Baseline'));
  assert.ok(markdown.includes('## Revenue Model by Consumer Tier'));
  assert.ok(markdown.includes('## Operating Cost Structure (Off-Chain & On-Chain)'));
  assert.ok(markdown.includes('## Reserve Requirements & Capital Buffer Policy'));
  assert.ok(markdown.includes('## Demand Sensitivity & Scenario Modeling'));
  assert.ok(markdown.includes('## Key Assumptions and Review Cadence'));
  assert.ok(markdown.includes('## Owner, Supported Scope, and Evidence'));
  assert.ok(markdown.includes('## Compatibility, Monitoring, and Operational Impact'));
  assert.ok(markdown.includes('## Rollout and Rollback Guidance'));
  assert.ok(markdown.includes(model.workstream));
  assert.ok(markdown.includes(model.owner));
});
