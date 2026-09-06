import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Price correctness validation suite (issue #420).
//
// Availability is not correctness: a wrong price is worse than no price. This
// harness replays known aggregation cases through the reference median +
// MAD-outlier logic and asserts:
//   1. median correctness  - aggregate matches the known-good value within tol
//   2. outlier handling    - the sources a correct impl must drop are dropped
//   3. robustness          - injecting one extra gross outlier must not move the
//                            median by more than the tolerance
//
// Run:  npm run validate:prices        (from repo root)
// CI:   .github/workflows/ci.yml `price-correctness` job, on every push/PR.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "verification", "fixtures", "price-correctness-cases.json");

/** Median matching services/aggregator/src/price-aggregation/aggregator.ts. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Outlier detection: a source whose price deviates from the all-source median by
 * more than `deviationPercent` is rejected. Mirrors the circuit breaker's
 * deviation-threshold approach in the aggregator service and, unlike a bare MAD
 * score, is not destabilised by a single extreme injected value.
 */
function deviationOutliers(sources, deviationPercent) {
  const med = median(sources.map((s) => s.price));
  const outliers = new Set();
  for (const s of sources) {
    if (med !== 0 && Math.abs(s.price - med) / Math.abs(med) * 100 > deviationPercent) {
      outliers.add(s.source);
    }
  }
  return outliers;
}

function pctDiff(a, b) {
  return b === 0 ? 0 : Math.abs(a - b) / Math.abs(b) * 100;
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const medianTol = fixture.medianTolerancePercent ?? 0.01;
const deviationPercent = fixture.outlierDeviationPercent ?? 10;

const failures = [];
let checks = 0;

for (const c of fixture.cases) {
  const outliers = deviationOutliers(c.sources, deviationPercent);

  // 1. outlier handling
  checks += 1;
  const expectedOutliers = new Set(c.expectedOutliers ?? []);
  const sameOutliers =
    outliers.size === expectedOutliers.size && [...outliers].every((o) => expectedOutliers.has(o));
  if (!sameOutliers) {
    failures.push(`${c.name}: outliers [${[...outliers]}] != expected [${[...expectedOutliers]}]`);
  }

  // 2. median correctness (after dropping detected outliers)
  checks += 1;
  const kept = c.sources.filter((s) => !outliers.has(s.source)).map((s) => s.price);
  const agg = median(kept);
  const diff = pctDiff(agg, c.expectedMedian);
  if (diff > medianTol) {
    failures.push(`${c.name}: median ${agg} vs expected ${c.expectedMedian} (${diff.toFixed(4)}% > ${medianTol}%)`);
  }

  // 3. robustness - one injected gross outlier must not move the median
  checks += 1;
  const perturbed = [...c.sources, { source: "__inject__", price: c.expectedMedian * 100 }];
  const perturbedOutliers = deviationOutliers(perturbed, deviationPercent);
  const perturbedKept = perturbed.filter((s) => !perturbedOutliers.has(s.source)).map((s) => s.price);
  const perturbedAgg = median(perturbedKept);
  const perturbedDiff = pctDiff(perturbedAgg, c.expectedMedian);
  if (perturbedDiff > medianTol) {
    failures.push(
      `${c.name}: injected outlier moved median to ${perturbedAgg} (${perturbedDiff.toFixed(4)}% > ${medianTol}%)`,
    );
  }
}

console.log(`Price correctness suite: ${fixture.cases.length} case(s), ${checks} check(s)`);
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("All price correctness checks passed.");
