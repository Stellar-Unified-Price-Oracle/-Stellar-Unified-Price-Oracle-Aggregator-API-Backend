import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Reconcile the modeled requested-capacity run rate (config/cost-model.json) with
// recorded provider invoices (config/cost-invoices.json) — issue #418.
//
//   npm run cost:reconcile              # report every recorded month
//   npm run cost:reconcile -- 2026-07   # report a single month
//   npm run cost:reconcile -- --check   # non-zero exit if latest variance > tolerance
//
// Tolerance defaults to 15% and can be overridden with COST_VARIANCE_TOLERANCE_PCT.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.join(root, "config", "cost-model.json");
const invoicesPath = path.join(root, "config", "cost-invoices.json");
const tolerancePct = Number(process.env.COST_VARIANCE_TOLERANCE_PCT ?? 15);

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

let worst = 0;
for (const invoice of rows) {
  const totalVariance = variancePct(modeledTotal, invoice.invoicedTotal);
  worst = Math.max(worst, Math.abs(totalVariance));
  console.log(`\n${invoice.month}  (reconciled by ${invoice.reconciledBy ?? "unknown"})`);
  console.log(`  modeled total   ${money(modeledTotal)}`);
  console.log(`  invoiced total  ${money(invoice.invoicedTotal)}`);
  console.log(`  variance        ${totalVariance.toFixed(1)}%  (tolerance ${tolerancePct}%)`);
  for (const [name, invoiced] of Object.entries(invoice.byService ?? {})) {
    const modeled = modeledByService[name] ?? 0;
    console.log(
      `    ${name.padEnd(12)} modeled ${money(modeled).padStart(9)}  invoiced ${money(invoiced).padStart(9)}  variance ${variancePct(modeled, invoiced).toFixed(1)}%`,
    );
  }
  if (invoice.notes) console.log(`  notes: ${invoice.notes}`);
}

if (checkMode && worst > tolerancePct) {
  console.error(`\nLatest reconciliation variance ${worst.toFixed(1)}% exceeds tolerance ${tolerancePct}%`);
  process.exit(1);
}
console.log("");
