#!/usr/bin/env node

const args = new Map();
for (let i = 0; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value.startsWith('--')) {
    const next = process.argv[i + 1];
    args.set(value, next && !next.startsWith('--') ? next : 'true');
    if (next && !next.startsWith('--')) {
      i += 1;
    }
  }
}

const peakRps = Number(args.get('--peak-rps') ?? process.env.PEAK_RPS ?? 125);
const p99Ms = Number(args.get('--p99-ms') ?? process.env.P99_MS ?? 700);
const targetRpsPerPod = Number(args.get('--target-rps-per-pod') ?? process.env.TARGET_RPS_PER_POD ?? 500);
const minReplicas = Number(args.get('--min-replicas') ?? process.env.MIN_REPLICAS ?? 2);
const maxReplicas = Number(args.get('--max-replicas') ?? process.env.MAX_REPLICAS ?? 10);
const scalingBuffer = Number(args.get('--scaling-buffer') ?? process.env.SCALING_BUFFER ?? 0.2);

// Observed inputs (#734): measured demand, feed count, and provider load.
const observedRps = Number(args.get('--observed-rps') ?? process.env.OBSERVED_RPS ?? peakRps);
const feedCount = Number(args.get('--feed-count') ?? process.env.FEED_COUNT ?? 0);
const rpsPerFeed = Number(args.get('--rps-per-feed') ?? process.env.RPS_PER_FEED ?? 0.5);
const providerLoad = Number(args.get('--provider-load') ?? process.env.PROVIDER_LOAD ?? 0.5);
const providerCapacityRps = Number(args.get('--provider-capacity-rps') ?? process.env.PROVIDER_CAPACITY_RPS ?? 2000);
const forecastHorizonDays = Number(args.get('--forecast-horizon-days') ?? process.env.FORECAST_HORIZON_DAYS ?? 30);
const growthRatePerDay = Number(args.get('--growth-rate-per-day') ?? process.env.GROWTH_RATE_PER_DAY ?? 0.01);
const confidence = Number(args.get('--confidence') ?? process.env.CONFIDENCE ?? 0.95);
const region = args.get('--region') ?? process.env.REGION ?? 'global';

if (!Number.isFinite(observedRps) || observedRps < 0) {
  throw new Error(`Invalid observed RPS: ${observedRps}`);
}
if (!Number.isFinite(feedCount) || feedCount < 0) {
  throw new Error(`Invalid feed count: ${feedCount}`);
}
if (!Number.isFinite(providerLoad) || providerLoad < 0 || providerLoad > 1) {
  throw new Error(`Invalid provider load (expected 0..1): ${providerLoad}`);
}
if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
  throw new Error(`Invalid confidence (expected 0..1 exclusive): ${confidence}`);
}

const sustainableRpsPerPod = Math.max(1, targetRpsPerPod * (1 - scalingBuffer));
const requiredReplicas = Math.max(minReplicas, Math.ceil(peakRps / sustainableRpsPerPod));
const recommendedReplicas = Math.min(maxReplicas, Math.max(requiredReplicas, Math.ceil(requiredReplicas * 1.2)));
const budget = Number(args.get('--monthly-budget') ?? process.env.MONTHLY_BUDGET ?? 30);
const estimatedCost = (recommendedReplicas * 12.5).toFixed(2);

// Forecast demand from observed traffic, feed growth, and provider load.
const feedDrivenRps = feedCount * rpsPerFeed;
const baseDemandRps = Math.max(observedRps, feedDrivenRps);
const providerPenalty = 1 + providerLoad * 0.5;
const forecastRps = baseDemandRps * Math.pow(1 + growthRatePerDay, forecastHorizonDays) * providerPenalty;

// Uncertainty: z-score approximation for the configured confidence level.
const zScore = confidence >= 0.99 ? 2.576 : confidence >= 0.95 ? 1.96 : confidence >= 0.9 ? 1.645 : 1.282;
const relativeUncertainty = 0.1 + providerLoad * 0.15 + Math.min(0.2, forecastHorizonDays / 365);
const forecastRpsLow = forecastRps * (1 - zScore * relativeUncertainty);
const forecastRpsHigh = forecastRps * (1 + zScore * relativeUncertainty);

const forecastReplicas = Math.max(minReplicas, Math.ceil(forecastRps / sustainableRpsPerPod));
const forecastReplicasLow = Math.max(minReplicas, Math.ceil(forecastRpsLow / sustainableRpsPerPod));
const forecastReplicasHigh = Math.max(minReplicas, Math.ceil(forecastRpsHigh / sustainableRpsPerPod));

const providerHeadroomRps = providerCapacityRps * (1 - providerLoad);
const providerHeadroomPercent = providerCapacityRps > 0
  ? Math.round((providerHeadroomRps / providerCapacityRps) * 100)
  : 0;
const capacityHeadroomRps = maxReplicas * sustainableRpsPerPod - forecastRps;
const capacityHeadroomPercent = forecastRps > 0
  ? Math.round((capacityHeadroomRps / forecastRps) * 100)
  : 100;

const report = {
  source: 'load-test-capacity-model',
  owner: 'global-operations-resilience',
  region,
  peakRps,
  p99Ms,
  observedRps,
  feedCount,
  rpsPerFeed,
  providerLoad,
  providerCapacityRps,
  forecastHorizonDays,
  growthRatePerDay,
  confidence,
  sustainableRpsPerPod,
  requiredReplicas,
  recommendedReplicas,
  minReplicas,
  maxReplicas,
  monthlyBudgetUsd: budget,
  projectedMonthlySpendUsd: Number(estimatedCost),
  headroomPercent: Math.max(10, Math.round((recommendedReplicas / requiredReplicas - 1) * 100)),
  forecast: {
    rps: Math.round(forecastRps),
    rpsRange: [Math.round(forecastRpsLow), Math.round(forecastRpsHigh)],
    replicas: forecastReplicas,
    replicasRange: [forecastReplicasLow, forecastReplicasHigh],
    confidence,
  },
  headroom: {
    capacityRps: Math.round(capacityHeadroomRps),
    capacityPercent: capacityHeadroomPercent,
    providerRps: Math.round(providerHeadroomRps),
    providerPercent: providerHeadroomPercent,
  },
  recommendation: requiredReplicas > maxReplicas || forecastReplicasHigh > maxReplicas
    ? 'Scale out immediately or reduce peak traffic density before launch.'
    : capacityHeadroomPercent < 20 || providerHeadroomPercent < 20
      ? 'Headroom is below the 20% target; plan a scale-out before the forecast horizon.'
      : 'Current capacity plan is within the configured scale-out ceiling with headroom for bursts.',
};

console.log('Capacity planning summary');
console.log(JSON.stringify(report, null, 2));
console.log('');
console.log(`Monthly capacity report: peak RPS ${peakRps} with a target 99th percentile latency of ${p99Ms}ms requires ${requiredReplicas} API replicas.`);
console.log(`Recommended steady-state fleet size: ${recommendedReplicas} replicas (${report.headroomPercent}% headroom above the immediate burst target).`);
console.log(`Projected monthly spend: $${estimatedCost} vs. $${budget.toFixed(2)} budget.`);
console.log('');
console.log(`Regional forecast (${region}, ${forecastHorizonDays}d @ ${(confidence * 100).toFixed(0)}% confidence): ${report.forecast.rps} RPS [${report.forecast.rpsRange[0]}-${report.forecast.rpsRange[1]}] -> ${forecastReplicas} replicas [${forecastReplicasLow}-${forecastReplicasHigh}].`);
console.log(`Headroom: capacity ${capacityHeadroomPercent}% (${report.headroom.capacityRps} RPS), provider ${providerHeadroomPercent}% (${report.headroom.providerRps} RPS).`);
console.log('');
console.log('Operational notes:');
console.log('- Owner: global-operations-resilience. Monitor forecast.rps vs. observed RPS and headroom.percent weekly; alert when headroom < 20%.');
console.log('- Rollout: run in shadow mode against production telemetry, compare to load-test model, then gate CI on headroom thresholds.');
console.log('- Rollback: revert this script; the previous load-test-only model remains the source of truth for capacity decisions.');
