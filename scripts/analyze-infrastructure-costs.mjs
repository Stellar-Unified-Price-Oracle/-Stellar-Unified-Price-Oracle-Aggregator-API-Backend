import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.join(root, "config", "cost-model.json");
const reportPath = path.join(root, "docs", "COST_OPTIMIZATION.md");

function aggregate(services, profile) {
  return services.reduce(
    (totals, service) => {
      const values = service[profile];
      totals.cpu += values.replicas * values.cpuCoresPerReplica;
      totals.memory += values.replicas * values.memoryGibPerReplica;
      totals.storage += values.storageGib;
      return totals;
    },
    { cpu: 0, memory: 0, storage: 0 },
  );
}

function monthlyCost(resources, model) {
  return (
    resources.cpu * model.rates.cpuPerVcpuHour * model.hoursPerMonth +
    resources.memory * model.rates.memoryPerGibHour * model.hoursPerMonth +
    resources.storage * model.rates.storagePerGibMonth
  );
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

function rate(value) {
  return `$${value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function percent(before, after) {
  return ((before - after) / before) * 100;
}

function serviceRow(service, model) {
  const baseline = aggregate([service], "baseline");
  const optimized = aggregate([service], "optimized");
  const before = monthlyCost(baseline, model);
  const after = monthlyCost(optimized, model);
  return `| ${service.name} | ${service.team} | ${service.optimized.replicas} | ${service.optimized.cpuCoresPerReplica} | ${service.optimized.memoryGibPerReplica} | ${money(before)} | ${money(after)} | ${percent(before, after).toFixed(1)}% |`;
}

function render(model) {
  const baseline = aggregate(model.services, "baseline");
  const optimized = aggregate(model.services, "optimized");
  const baselineCost = monthlyCost(baseline, model);
  const optimizedCost = monthlyCost(optimized, model);
  const savings = baselineCost - optimizedCost;
  const reduction = percent(baselineCost, optimizedCost);
  const warningBudget =
    model.budget.monthly * (model.budget.warningPercent / 100);

  return `# Infrastructure Cost Optimization Report

This report is generated from \`config/cost-model.json\` by \`npm run cost:analyze\`.
It models Kubernetes requested capacity, which is the controllable cost driver in
the repository. Replace the documented rates with the cluster provider's effective
rates when reconciling this forecast against an invoice.

## Executive summary

| Metric | Baseline | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| Requested CPU | ${baseline.cpu.toFixed(3)} vCPU | ${optimized.cpu.toFixed(3)} vCPU | ${percent(baseline.cpu, optimized.cpu).toFixed(1)}% |
| Requested memory | ${baseline.memory.toFixed(3)} GiB | ${optimized.memory.toFixed(3)} GiB | ${percent(baseline.memory, optimized.memory).toFixed(1)}% |
| Modeled monthly run rate | ${money(baselineCost)} | ${money(optimizedCost)} | ${reduction.toFixed(1)}% |

The production overlay keeps all ${model.services.reduce((sum, service) => sum + service.optimized.replicas, 0)} replicas and the 10 GiB database volume. Right-sizing saves a modeled
${money(savings)} per month (${reduction.toFixed(1)}%), exceeding the issue's 20% target
without reducing redundancy.

## Cost allocation and recommendations

| Service | Owning team | Replicas | CPU request/replica | Memory request/replica (GiB) | Baseline/month | Optimized/month | Reduction |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${model.services.map((service) => serviceRow(service, model)).join("\n")}

Production pods and the namespace carry \`cost.stellar.org/service\`,
\`cost.stellar.org/team\`, and \`cost.stellar.org/environment\` labels. These labels
support invoice allocation and Prometheus grouping by service and team.

Implemented recommendations:

- API requests: 100m/256Mi to 50m/128Mi per replica.
- Aggregator requests: 100m/256Mi to 75m/192Mi per replica.
- TimescaleDB requests: 250m/512Mi to 200m/384Mi.
- Limits remain above requests to absorb bursts; probes and replica counts are unchanged.
- A namespace ResourceQuota caps accidental capacity growth.
- Budget alerts evaluate the Kubernetes requested-capacity monthly run rate.

## Budget and alerts

The configured production budget is ${money(model.budget.monthly)} per month.
\`StellarOracleCostBudgetWarning\` fires at ${money(warningBudget)}
(${model.budget.warningPercent}%), and \`StellarOracleCostBudgetExceeded\` fires at
${money(model.budget.monthly)} (${model.budget.criticalPercent}%).

The alert expression uses kube-state-metrics request and PVC metrics. Alert routing
must send labels \`team=platform\` and \`cost_center=stellar-oracle\` to the
organization's notification receiver. Rates and thresholds live in both the
cost-model source and the production monitoring manifest so changes are reviewable.
The \`stellar_oracle:requested_monthly_cost_usd_by_service_team\` recording rule
exposes the same model grouped by the pod allocation labels for dashboards and
chargeback reports.

## Assumptions and verification

- ${model.hoursPerMonth} hours per month.
- CPU: ${rate(model.rates.cpuPerVcpuHour)} per vCPU-hour.
- Memory: ${rate(model.rates.memoryPerGibHour)} per GiB-hour.
- Persistent storage: ${rate(model.rates.storagePerGibMonth)} per GiB-month.
- Network egress, managed control-plane fees, taxes, and discounts are excluded.
- Validate the recommendation for at least seven days. CPU p95 should remain below
  70% of requests, memory p95 below 80%, and throttling/error SLOs unchanged.
- If those thresholds are exceeded, raise the affected request independently and
  regenerate this report rather than reducing replicas.

Run \`npm run cost:check\` in CI or before review to prove the committed report is
in sync with the model and still exceeds the 20% reduction target.
`;
}

const model = JSON.parse(await readFile(modelPath, "utf8"));
const report = render(model);
const baseline = aggregate(model.services, "baseline");
const optimized = aggregate(model.services, "optimized");
const reduction = percent(
  monthlyCost(baseline, model),
  monthlyCost(optimized, model),
);

if (reduction < 20) {
  throw new Error(`Projected reduction ${reduction.toFixed(1)}% is below 20%`);
}

if (process.argv.includes("--check")) {
  const committed = await readFile(reportPath, "utf8");
  if (committed.replaceAll("\r\n", "\n") !== report) {
    throw new Error("docs/COST_OPTIMIZATION.md is stale; run npm run cost:analyze");
  }
  console.log(`Cost report is current; projected reduction ${reduction.toFixed(1)}%`);
} else {
  await writeFile(reportPath, report);
  console.log(`Generated ${path.relative(root, reportPath)} (${reduction.toFixed(1)}% reduction)`);
}
