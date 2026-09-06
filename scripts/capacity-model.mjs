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

const sustainableRpsPerPod = Math.max(1, targetRpsPerPod * (1 - scalingBuffer));
const requiredReplicas = Math.max(minReplicas, Math.ceil(peakRps / sustainableRpsPerPod));
const recommendedReplicas = Math.min(maxReplicas, Math.max(requiredReplicas, Math.ceil(requiredReplicas * 1.2)));
const budget = Number(args.get('--monthly-budget') ?? process.env.MONTHLY_BUDGET ?? 30);
const estimatedCost = (recommendedReplicas * 12.5).toFixed(2);

const report = {
  source: 'load-test-capacity-model',
  peakRps,
  p99Ms,
  sustainableRpsPerPod,
  requiredReplicas,
  recommendedReplicas,
  minReplicas,
  maxReplicas,
  monthlyBudgetUsd: budget,
  projectedMonthlySpendUsd: Number(estimatedCost),
  headroomPercent: Math.max(10, Math.round((recommendedReplicas / requiredReplicas - 1) * 100)),
  recommendation: requiredReplicas > maxReplicas
    ? 'Scale out immediately or reduce peak traffic density before launch.'
    : 'Current capacity plan is within the configured scale-out ceiling with headroom for bursts.',
};

console.log('Capacity planning summary');
console.log(JSON.stringify(report, null, 2));
console.log('');
console.log(`Monthly capacity report: peak RPS ${peakRps} with a target 99th percentile latency of ${p99Ms}ms requires ${requiredReplicas} API replicas.`);
console.log(`Recommended steady-state fleet size: ${recommendedReplicas} replicas (${report.headroomPercent}% headroom above the immediate burst target).`);
console.log(`Projected monthly spend: $${estimatedCost} vs. $${budget.toFixed(2)} budget.`);
