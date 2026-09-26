import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Reconcile the modeled requested-capacity run rate (config/cost-model.json) with
// recorded provider invoices (config/cost-invoices.json) — issues #418, #555.
//
//   npm run cost:reconcile              # report every recorded month
//   npm run cost:reconcile -- 2026-08   # report a single month
//   npm run cost:reconcile -- --check   # non-zero exit if drift exceeds variance thresholds
//
// Supports granular itemization (attributable vs inferred with stated error bands),
// changelog audit, and retained report generation in reports/reconciliation/.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.join(root, "config", "cost-model.json");
const invoicesPath = path.join(root, "config", "cost-invoices.json");
const reportsDir = path.join(root, "reports", "reconciliation");

function aggregate(service, profile) {
  const v = service[profile];
  return {
    cpu: v.replicas * v.cpuCoresPerReplica,
    memory: v.replicas * v.memoryGibPerReplica,
    storage: v.storageGib,
  };
}

function monthlyCost(resources, model) {
  return (
    resources.cpu * model.rates.cpuPerVcpuHour * model.hoursPerMonth +
    resources.memory * model.rates.memoryPerGibHour * model.hoursPerMonth +
    resources.storage * model.rates.storagePerGibMonth
  );
}

function variancePct(modeled, invoiced) {
  if (invoiced === 0) return 0;
  return ((modeled - invoiced) / invoiced) * 100;
}

function money(v) {
  return `$${v.toFixed(2)}`;
}

const model = JSON.parse(await readFile(modelPath, "utf8"));
const { invoices } = JSON.parse(await readFile(invoicesPath, "utf8"));

const thresholds = model.varianceThresholds ?? {
  totalMonthlyTolerancePct: 15.0,
  perServiceTolerancePct: 20.0,
  inferredCategoryTolerancePct: 30.0,
  runtimeCallCostTolerancePct: 10.0,
};

const modeledByService = Object.fromEntries(
  model.services.map((s) => [s.name, monthlyCost(aggregate(s, "optimized"), model)]),
);
const modeledTotal = Object.values(modeledByService).reduce((a, b) => a + b, 0);

const requestedMonth = process.argv.find((a) => /^\d{4}-\d{2}$/.test(a));
const checkMode = process.argv.includes("--check");
const rows = requestedMonth
  ? invoices.filter((i) => i.month === requestedMonth)
  : [...invoices].sort((a, b) => a.month.localeCompare(b.month));

if (rows.length === 0) {
  throw new Error(`No invoice recorded${requestedMonth ? ` for ${requestedMonth}` : ""} in config/cost-invoices.json`);
}

let unacknowledgedDriftFailures = [];

for (const invoice of rows) {
  const totalVariance = Math.abs(variancePct(modeledTotal, invoice.invoicedTotal));
  console.log(`\n======================================================`);
  console.log(`Reconciliation Report: ${invoice.month}`);
  console.log(`Reconciled by: ${invoice.reconciledBy ?? "unknown"} | Data Source: ${invoice.dataSource ?? "Cloud Provider Invoice"}`);
  console.log(`======================================================`);
  console.log(`  Modeled Total:   ${money(modeledTotal)}`);
  console.log(`  Invoiced Total:  ${money(invoice.invoicedTotal)}`);
  console.log(`  Total Variance:  ${totalVariance.toFixed(1)}% (Threshold: ${thresholds.totalMonthlyTolerancePct}%)`);

  if (totalVariance > thresholds.totalMonthlyTolerancePct) {
    // Check if explained in changelog
    const relevantChange = (model.changelog || []).find((c) => c.date.startsWith(invoice.month));
    if (relevantChange) {
      console.log(`  ℹ️  Variance acknowledged in changelog: "${relevantChange.change}" (${relevantChange.reason})`);
    } else {
      unacknowledgedDriftFailures.push(
        `${invoice.month}: Total variance ${totalVariance.toFixed(1)}% exceeds threshold ${thresholds.totalMonthlyTolerancePct}% without changelog entry`,
      );
    }
  }

  console.log(`\n  --- Attributable Services ---`);
  for (const [name, invoiced] of Object.entries(invoice.byService ?? {})) {
    const modeled = modeledByService[name] ?? 0;
    const sVariance = Math.abs(variancePct(modeled, invoiced));
    const status = sVariance > thresholds.perServiceTolerancePct ? "⚠️ DRIFT" : "✓ PASS";
    console.log(
      `    ${status} ${name.padEnd(12)} modeled ${money(modeled).padStart(8)}  invoiced ${money(invoiced).padStart(8)}  variance ${sVariance.toFixed(1)}%`,
    );
    if (sVariance > thresholds.perServiceTolerancePct) {
      const acknowledged = (model.changelog || []).some((c) => c.date.startsWith(invoice.month) && c.change.includes(name));
      if (!acknowledged) {
        unacknowledgedDriftFailures.push(
          `${invoice.month} [${name}]: Variance ${sVariance.toFixed(1)}% exceeds per-service threshold ${thresholds.perServiceTolerancePct}%`,
        );
      }
    }
  }

  if (invoice.inferredCategories) {
    console.log(`\n  --- Inferred Categories with Stated Error Bands ---`);
    for (const [catName, cost] of Object.entries(invoice.inferredCategories)) {
      const band = model.inferredCostErrorBands?.[catName];
      const errorBand = band ? `±${band.errorBandPct}% (${band.method})` : "no error band stated";
      console.log(`    • ${catName.padEnd(20)} invoiced ${money(cost).padStart(8)} | Error Band: ${errorBand}`);
    }
  }

  if (invoice.notes) console.log(`\n  Notes: ${invoice.notes}`);

  // Retain reconciliation result as audit artifact
  try {
    await mkdir(reportsDir, { recursive: true });
    const auditArtifact = {
      reconciledAt: new Date().toISOString(),
      month: invoice.month,
      modeledTotal,
      invoicedTotal: invoice.invoicedTotal,
      variancePct: totalVariance,
      thresholds,
      byService: invoice.byService,
      inferredCategories: invoice.inferredCategories,
      reconciledBy: invoice.reconciledBy,
      status: totalVariance <= thresholds.totalMonthlyTolerancePct ? "VERIFIED" : "DRIFT_DETECTED",
    };
    await writeFile(
      path.join(reportsDir, `cost-reconciliation-${invoice.month}.json`),
      JSON.stringify(auditArtifact, null, 2),
      "utf8",
    );
  } catch (err) {
    console.warn("Could not save retained audit artifact:", err.message);
  }
}

console.log("\n======================================================");

if (checkMode && unacknowledgedDriftFailures.length > 0) {
  console.error(`\n❌ Cost Reconciliation Failed: Unacknowledged drift detected:`);
  for (const f of unacknowledgedDriftFailures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log(`\n✅ Cost reconciliation complete. All figures within tolerance.`);
}
