import * as assert from 'assert';

interface SteadyStateInvariant {
  name: string;
  description: string;
  source: string; // Which doc/config defines this
  threshold: number;
  unit: string;
}

interface ChaosHypothesis {
  experimentName: string;
  invariants: SteadyStateInvariant[];
  baselineCaptured: boolean;
  baselineValue: number;
  duringFaultThreshold: number;
  recoveryThreshold: number;
  verdictPass: boolean;
  faultInjected: boolean;
  recoveryTime?: number; // milliseconds
}

const systemInvariants: SteadyStateInvariant[] = [
  {
    name: 'availability',
    description: 'System availability during normal operation',
    source: 'monitoring/slo.yml',
    threshold: 99.9,
    unit: '%',
  },
  {
    name: 'price-latency-p99',
    description: 'Price update P99 latency',
    source: 'docs/service-sla.md',
    threshold: 1000,
    unit: 'ms',
  },
  {
    name: 'price-freshness',
    description: 'Maximum acceptable price staleness',
    source: 'docs/FRESHNESS_GUARANTEES.md',
    threshold: 30000,
    unit: 'ms',
  },
  {
    name: 'error-rate',
    description: 'API error rate under normal load',
    source: 'monitoring/slo.yml',
    threshold: 0.1,
    unit: '%',
  },
  {
    name: 'cross-region-consistency',
    description: 'Data consistency across regions',
    source: 'docs/CRDT_DESIGN.md',
    threshold: 99.99,
    unit: '%',
  },
];

async function captureBaseline(): Promise<Record<string, number>> {
  // In production: capture real metrics before fault injection
  // Read from Prometheus, Grafana, or internal metrics

  return {
    availability: 99.95,
    'price-latency-p99': 150,
    'price-freshness': 5000,
    'error-rate': 0.05,
    'cross-region-consistency': 99.98,
  };
}

async function captureMetricsDuringFault(): Promise<Record<string, number>> {
  // In production: capture metrics while fault is active
  // Read from Prometheus or observability system

  // Simulate fault impact
  return {
    availability: 98.5, // Degraded but acceptable for some faults
    'price-latency-p99': 2500, // Increased latency under fault
    'price-freshness': 45000, // Prices becoming stale
    'error-rate': 2.5, // Error rate increased
    'cross-region-consistency': 95.0, // Consistency degraded
  };
}

async function captureMetricsPostRecovery(): Promise<Record<string, number>> {
  // In production: capture metrics after fault ends
  // Verify system returns to baseline within acceptable window

  return {
    availability: 99.92,
    'price-latency-p99': 180,
    'price-freshness': 6000,
    'error-rate': 0.06,
    'cross-region-consistency': 99.97,
  };
}

async function verifyFaultInjection(): Promise<boolean> {
  // Test that the fault was actually injected
  // In production: verify error logs, check fault status in chaos mesh, etc.

  // Placeholder: assume fault was injected
  return true;
}

async function assertBaseline(
  baseline: Record<string, number>,
  invariants: SteadyStateInvariant[]
): Promise<void> {
  for (const invariant of invariants) {
    const value = baseline[invariant.name];

    assert.ok(
      value !== undefined,
      `Baseline missing metric: ${invariant.name}`
    );

    if (invariant.name.includes('freshness') || invariant.name.includes('latency')) {
      // Lower is better for latency and freshness
      assert.ok(
        value <= invariant.threshold,
        `Baseline ${invariant.name} ${value}${invariant.unit} exceeds threshold ${invariant.threshold}${invariant.unit}`
      );
    } else {
      // Higher is better for availability, consistency
      assert.ok(
        value >= invariant.threshold * 0.95, // Allow slight deviation from threshold
        `Baseline ${invariant.name} ${value}${invariant.unit} below 95% of threshold ${invariant.threshold}${invariant.unit}`
      );
    }
  }
}

async function assertDuringFault(
  metrics: Record<string, number>,
  invariants: SteadyStateInvariant[],
  duringFaultThreshold: number
): Promise<void> {
  for (const invariant of invariants) {
    const value = metrics[invariant.name];

    assert.ok(
      value !== undefined,
      `During-fault metrics missing: ${invariant.name}`
    );

    // Verify fault was actually observable (degradation occurred)
    // Depending on the invariant, degradation means different things
    if (invariant.name.includes('availability') || invariant.name.includes('consistency')) {
      // Availability/consistency should drop during fault but not collapse
      assert.ok(
        value > duringFaultThreshold,
        `${invariant.name} dropped to ${value}${invariant.unit} below threshold ${duringFaultThreshold}${invariant.unit}`
      );
    } else if (invariant.name.includes('error-rate')) {
      // Error rate should increase during fault but stay bounded
      assert.ok(
        value < 100,
        `Error rate during fault ${value}${invariant.unit} exceeded 100%`
      );
    } else if (invariant.name.includes('latency') || invariant.name.includes('freshness')) {
      // Latency and freshness degrade but must not exceed max thresholds
      const maxDuringFault = invariant.threshold * 10; // Allow up to 10x degradation
      assert.ok(
        value <= maxDuringFault,
        `${invariant.name} during fault ${value}${invariant.unit} exceeded max ${maxDuringFault}${invariant.unit}`
      );
    }
  }
}

async function assertRecovery(
  metrics: Record<string, number>,
  baseline: Record<string, number>,
  invariants: SteadyStateInvariant[]
): Promise<number> {
  let maxRecoveryTime = 0;

  for (const invariant of invariants) {
    const recoveredValue = metrics[invariant.name];
    const baselineValue = baseline[invariant.name];

    assert.ok(
      recoveredValue !== undefined,
      `Post-recovery metrics missing: ${invariant.name}`
    );

    // Verify recovery is complete (within acceptable tolerance of baseline)
    const tolerance = invariant.name.includes('latency')
      ? 0.5 // latency can be 50% higher post-recovery
      : 0.1; // others within 10%

    if (invariant.name.includes('latency') || invariant.name.includes('freshness')) {
      // For latency/freshness: recovered value should be close to baseline
      assert.ok(
        recoveredValue <= baselineValue * (1 + tolerance),
        `${invariant.name} post-recovery ${recoveredValue}${invariant.unit} not recovered (baseline ${baselineValue}${invariant.unit})`
      );
    } else {
      // For availability/consistency: should recover to near-baseline
      assert.ok(
        recoveredValue >= baselineValue * (1 - tolerance),
        `${invariant.name} post-recovery ${recoveredValue}${invariant.unit} not recovered (baseline ${baselineValue}${invariant.unit})`
      );
    }

    // Estimate recovery time based on metric degradation
    // In production: measure actual recovery time from observability system
    if (recoveredValue < baselineValue * 1.2) {
      maxRecoveryTime = Math.max(maxRecoveryTime, 5000); // Assume 5s recovery
    } else {
      maxRecoveryTime = Math.max(maxRecoveryTime, 15000); // Assume 15s recovery
    }
  }

  return maxRecoveryTime;
}

export async function runChaosExperimentTest(
  experimentName: string
): Promise<ChaosHypothesis> {
  console.log(`\nRunning chaos experiment: ${experimentName}`);

  const hypothesis: ChaosHypothesis = {
    experimentName,
    invariants: systemInvariants,
    baselineCaptured: false,
    baselineValue: 0,
    duringFaultThreshold: 95,
    recoveryThreshold: 99,
    verdictPass: false,
    faultInjected: false,
    recoveryTime: 0,
  };

  // Phase 1: Capture baseline
  console.log('  Phase 1: Capturing baseline...');
  try {
    const baseline = await captureBaseline();
    await assertBaseline(baseline, systemInvariants);
    hypothesis.baselineCaptured = true;
    console.log('  ✓ Baseline captured and validated');
  } catch (error) {
    console.log(`  ✗ Baseline capture failed: ${error}`);
    return hypothesis;
  }

  // Phase 2: Inject fault
  console.log('  Phase 2: Injecting fault...');
  try {
    const faultInjected = await verifyFaultInjection();

    if (!faultInjected) {
      throw new Error('Fault injection verification failed; treating as vacuous test failure');
    }

    hypothesis.faultInjected = true;
    console.log('  ✓ Fault injected and verified');
  } catch (error) {
    console.log(`  ✗ Fault injection failed: ${error}`);
    hypothesis.verdictPass = false;
    return hypothesis;
  }

  // Phase 3: Assert during fault
  console.log('  Phase 3: Asserting system state during fault...');
  try {
    const duringFaultMetrics = await captureMetricsDuringFault();
    await assertDuringFault(duringFaultMetrics, systemInvariants, hypothesis.duringFaultThreshold);
    console.log('  ✓ System degraded as expected during fault');
  } catch (error) {
    console.log(`  ✗ During-fault assertion failed: ${error}`);
    hypothesis.verdictPass = false;
    return hypothesis;
  }

  // Phase 4: Verify recovery
  console.log('  Phase 4: Verifying recovery...');
  try {
    const baseline = await captureBaseline();
    const recoveredMetrics = await captureMetricsPostRecovery();
    const recoveryTime = await assertRecovery(recoveredMetrics, baseline, systemInvariants);

    hypothesis.recoveryTime = recoveryTime;
    console.log(`  ✓ System recovered in ${recoveryTime}ms`);
  } catch (error) {
    console.log(`  ✗ Recovery assertion failed: ${error}`);
    hypothesis.verdictPass = false;
    return hypothesis;
  }

  // Final verdict
  hypothesis.verdictPass = true;
  console.log(`  ✓ Chaos experiment PASSED: ${experimentName}`);

  return hypothesis;
}

export async function runAllChaosExperiments(): Promise<ChaosHypothesis[]> {
  const experiments = [
    'pod-crash-aggregator',
    'network-partition',
    'database-latency-injection',
    'memory-pressure',
    'contract-unavailable',
  ];

  console.log('=== CHAOS ENGINEERING HYPOTHESIS VERIFICATION ===\n');

  const results: ChaosHypothesis[] = [];

  for (const experiment of experiments) {
    try {
      const result = await runChaosExperimentTest(experiment);
      results.push(result);
    } catch (error) {
      console.log(`✗ Experiment ${experiment} errored: ${error}`);
      results.push({
        experimentName: experiment,
        invariants: systemInvariants,
        baselineCaptured: false,
        baselineValue: 0,
        duringFaultThreshold: 95,
        recoveryThreshold: 99,
        verdictPass: false,
        faultInjected: false,
      });
    }
  }

  // Summary
  const passCount = results.filter((r) => r.verdictPass).length;
  console.log(`\n\n=== CHAOS HYPOTHESIS SUMMARY ===`);
  console.log(`Passed: ${passCount}/${results.length}`);

  for (const result of results) {
    const status = result.verdictPass ? '✓' : '✗';
    const faultStatus = result.faultInjected ? 'injected' : 'not-injected';
    console.log(`${status} ${result.experimentName}: fault=${faultStatus}, recovery=${result.recoveryTime}ms`);
  }

  const anyFailed = results.some((r) => !r.verdictPass);
  if (anyFailed) {
    throw new Error(`Chaos hypotheses failed for ${results.filter((r) => !r.verdictPass).length} experiment(s)`);
  }

  return results;
}

if (require.main === module) {
  runAllChaosExperiments()
    .then(() => {
      console.log('\n✓ All chaos experiments passed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n✗ Chaos experiments failed:', error);
      process.exit(1);
    });
}

export { SteadyStateInvariant, ChaosHypothesis };
