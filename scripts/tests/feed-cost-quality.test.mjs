import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateCompositeQualityScore,
  evaluateFeed,
  runFeedCostQualityComparison,
  renderFeedCostQualityReport,
} from '../compare-feed-cost-quality.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(root, 'config', 'feed-cost-quality.json');

async function loadTestManifest() {
  const content = await readFile(configPath, 'utf8');
  return JSON.parse(content);
}

test('calculateCompositeQualityScore computes weighted scores accurately', () => {
  const qualityMetrics = {
    freshnessP50Ms: 1000,
    freshnessP95Ms: 2000,
    maxStalenessSeconds: 120,
    stalenessViolationRatePct: 0.0,
    activeSourcesCount: 4,
    configuredSourcesCount: 4,
    sourceQuorum: 3,
    medianPriceSpreadBps: 1.5,
    measuredAccuracyPct: 99.8,
  };

  const score = calculateCompositeQualityScore(qualityMetrics);

  assert.ok(score.freshnessScore > 90);
  assert.equal(score.coverageScore, 100);
  assert.ok(score.accuracyScore > 98);
  assert.ok(score.compositeScore > 95 && score.compositeScore <= 100);
});

test('evaluateFeed computes unit cost per 1k submissions and quality-per-dollar efficiency', async () => {
  const manifest = await loadTestManifest();
  const feed = manifest.feeds[0]; // xlm-usd

  const evaluated = evaluateFeed(feed, manifest.evaluationWeights);

  assert.equal(evaluated.feedId, 'xlm-usd');
  assert.ok(evaluated.unitEconomics.costPer1kSubmissionsUsd > 0);
  assert.ok(evaluated.unitEconomics.qualityPointsPerDollar > 0);

  // xlm-usd has 86,400 submissions and $44.61 monthly cost
  // (44.61 / 86400) * 1000 = ~0.5163
  assert.equal(evaluated.unitEconomics.costPer1kSubmissionsUsd, 0.5163);
});

test('runFeedCostQualityComparison aggregates all 5 feeds with complete summary', async () => {
  const manifest = await loadTestManifest();
  const comparison = runFeedCostQualityComparison(manifest);

  assert.equal(comparison.summary.totalFeedsCount, 5);
  assert.ok(comparison.summary.totalMonthlyCostUsd > 200);
  assert.ok(comparison.summary.totalMonthlySubmissions > 400000);
  assert.ok(comparison.summary.averageQualityScore >= 90);

  const feedIds = comparison.feeds.map((f) => f.feedId);
  assert.deepEqual(feedIds, ['xlm-usd', 'usdc-usd', 'btc-usd', 'eth-usd', 'usdt-usd']);
});

test('boundary cases: zero cost, missing sources, and latency ceilings', () => {
  // Feed with zero operating cost
  const freeFeed = {
    feedId: 'free-test-feed',
    asset: 'TEST',
    pair: 'TEST/USD',
    cadenceSeconds: 60,
    monthlySubmissions: 43200,
    costMetrics: {
      providerIngestionMonthlyUsd: 0,
      aggregationComputeMonthlyUsd: 0,
      timescaleStorageMonthlyUsd: 0,
      onChainGasMonthlyUsd: 0,
      totalMonthlyCostUsd: 0,
    },
    qualityMetrics: {
      freshnessP50Ms: 500,
      freshnessP95Ms: 1000,
      maxStalenessSeconds: 120,
      stalenessViolationRatePct: 0,
      activeSourcesCount: 4,
      configuredSourcesCount: 4,
      sourceQuorum: 3,
      medianPriceSpreadBps: 1.0,
      measuredAccuracyPct: 100,
    },
    recommendations: {
      pricingCategory: 'Free Tier',
      capacityStatus: 'Minimal',
      actionGuidance: 'None',
    },
  };

  const evaluated = evaluateFeed(freeFeed);
  assert.equal(evaluated.unitEconomics.costPer1kSubmissionsUsd, 0);
  assert.equal(evaluated.unitEconomics.qualityPointsPerDollar, 0); // No division-by-zero error

  // Degraded feed with only 1 source active (below quorum of 3)
  const degradedScore = calculateCompositeQualityScore({
    freshnessP95Ms: 60000,
    maxStalenessSeconds: 60,
    stalenessViolationRatePct: 0.1,
    activeSourcesCount: 1,
    configuredSourcesCount: 4,
    sourceQuorum: 3,
    medianPriceSpreadBps: 50,
    measuredAccuracyPct: 90,
  });

  assert.ok(degradedScore.coverageScore < 40);
  assert.ok(degradedScore.freshnessScore < 50);
  assert.ok(degradedScore.compositeScore < 50);
});

test('failure cases: negative cost, zero submissions, or invalid manifest throw errors', () => {
  assert.throws(() => runFeedCostQualityComparison(null), /Feed cost quality manifest must contain at least one feed/);
  assert.throws(() => runFeedCostQualityComparison({ feeds: [] }), /Feed cost quality manifest must contain at least one feed/);

  assert.throws(
    () =>
      evaluateFeed({
        feedId: 'bad-feed',
        monthlySubmissions: 0,
        costMetrics: { totalMonthlyCostUsd: 10 },
        qualityMetrics: {},
      }),
    /Invalid cost or submission count/
  );

  assert.throws(
    () =>
      calculateCompositeQualityScore({
        freshnessP95Ms: -100,
        activeSourcesCount: 4,
        configuredSourcesCount: 4,
      }),
    /Invalid quality metric boundaries/
  );
});

test('renderFeedCostQualityReport generates markdown with required governance and operational sections', async () => {
  const manifest = await loadTestManifest();
  const comparison = runFeedCostQualityComparison(manifest);
  const markdown = renderFeedCostQualityReport(comparison);

  assert.ok(markdown.includes('# Feed Cost and Delivered Quality Comparison (Issue #787)'));
  assert.ok(markdown.includes('## Executive Summary & Comparison Matrix'));
  assert.ok(markdown.includes('## Feed Cost Decomposition & Unit Economics'));
  assert.ok(markdown.includes('## Quality Metrics: Freshness, Coverage, and Accuracy'));
  assert.ok(markdown.includes('## Comparative Evaluation & Capacity/Pricing Recommendations'));
  assert.ok(markdown.includes('## Review Procedure and Completion Evidence'));
  assert.ok(markdown.includes('## Owner, Supported Scope, and Limitations'));
  assert.ok(markdown.includes('## Compatibility and Operational Impact'));
  assert.ok(markdown.includes('## Rollout and Rollback Guidance'));
  assert.ok(markdown.includes(manifest.owner));

  for (const feed of manifest.feeds) {
    assert.ok(markdown.includes(feed.feedId));
    assert.ok(markdown.includes(feed.pair));
  }
});
