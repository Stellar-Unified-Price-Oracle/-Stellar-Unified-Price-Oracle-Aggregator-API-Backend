#!/usr/bin/env node

/**
 * scripts/service-credits.mjs — issue #794
 *
 * Auditable method for associating eligible service incidents with consumer credits:
 * classify incidents for eligibility, merge overlapping downtime per region and SLI,
 * derive monthly attainment, map it to the credit schedule, and reconcile against the
 * independently measured SLO attainment. Produces a hashed credit ledger in
 * docs/SERVICE_CREDIT_RECONCILIATION.md.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const creditsPath = path.join(root, 'config', 'service-credits.json');
const sustainabilityPath = path.join(root, 'config', 'sustainability-model.json');
const reportPath = path.join(root, 'docs', 'SERVICE_CREDIT_RECONCILIATION.md');

const MINUTE_MS = 60000;

export function monthWindow(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(period ?? '');
  if (!match) throw new Error(`period must be YYYY-MM, got "${period}"`);
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  const end = Date.UTC(Number(match[1]), Number(match[2]), 1);
  return { start, end, minutes: (end - start) / MINUTE_MS };
}

export function validateIncidents(manifest) {
  const errors = [];
  const { policy, incidents = [], regions = [] } = manifest;
  const known = new Set(policy.knownCauses);
  const ids = new Set();
  for (const inc of incidents) {
    const label = `incident ${inc.id}`;
    if (ids.has(inc.id)) errors.push(`${label}: duplicate id`);
    ids.add(inc.id);
    if (!policy.slis[inc.sli]) errors.push(`${label}: unknown SLI "${inc.sli}"`);
    if (!known.has(inc.cause)) errors.push(`${label}: unknown cause "${inc.cause}"`);
    const start = Date.parse(inc.startedAt);
    const end = Date.parse(inc.endedAt);
    if (Number.isNaN(start)) errors.push(`${label}: startedAt is not a valid timestamp`);
    if (!inc.endedAt) errors.push(`${label}: still open; credits are computed only for resolved incidents`);
    else if (Number.isNaN(end)) errors.push(`${label}: endedAt is not a valid timestamp`);
    else if (end <= start) errors.push(`${label}: endedAt must be after startedAt`);
    if (!Array.isArray(inc.regions) || inc.regions.length === 0) errors.push(`${label}: regions are required`);
    for (const r of inc.regions ?? []) {
      if (r !== '*' && !regions.includes(r)) errors.push(`${label}: unknown region "${r}"`);
    }
    if (!inc.evidence) errors.push(`${label}: evidence is required`);
    if (!inc.classifiedBy || !inc.approvedBy) errors.push(`${label}: classifiedBy and approvedBy are required`);
    else if (inc.classifiedBy === inc.approvedBy) errors.push(`${label}: classification must be approved by a second person`);
    if (inc.cause === 'scheduled-maintenance' && !Number.isFinite(inc.maintenanceNoticeHours)) {
      errors.push(`${label}: scheduled maintenance requires maintenanceNoticeHours`);
    }
  }
  return errors;
}

export function classifyEligibility(incident, policy) {
  if (incident.cause === 'scheduled-maintenance') {
    return incident.maintenanceNoticeHours >= policy.minimumMaintenanceNoticeHours
      ? { eligible: false, reason: `announced ${incident.maintenanceNoticeHours}h ahead (>= ${policy.minimumMaintenanceNoticeHours}h)` }
      : { eligible: true, reason: `notice ${incident.maintenanceNoticeHours}h is below the ${policy.minimumMaintenanceNoticeHours}h minimum` };
  }
  if (policy.excludedCauses.includes(incident.cause)) {
    return { eligible: false, reason: `excluded cause: ${incident.cause}` };
  }
  return { eligible: true, reason: `eligible cause: ${incident.cause}` };
}

export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
      last.ids = [...new Set([...last.ids, ...iv.ids])];
    } else {
      merged.push({ ...iv, ids: [...iv.ids] });
    }
  }
  return merged;
}

export function creditPctFor(attainmentPct, schedule) {
  let credit = 0;
  for (const band of schedule) {
    if (attainmentPct < band.belowPct) credit = Math.max(credit, band.creditPct);
  }
  return credit;
}

export function computeAttainment(manifest) {
  const window = monthWindow(manifest.period);
  const classified = manifest.incidents.map((inc) => ({ ...inc, ...classifyEligibility(inc, manifest.policy) }));
  const attainment = {};
  for (const region of manifest.regions) {
    attainment[region] = {};
    for (const sli of Object.keys(manifest.policy.slis)) {
      const intervals = classified
        .filter((i) => i.eligible && i.sli === sli && (i.regions.includes('*') || i.regions.includes(region)))
        .map((i) => ({
          start: Math.max(Date.parse(i.startedAt), window.start),
          end: Math.min(Date.parse(i.endedAt), window.end),
          ids: [i.id],
        }))
        .filter((iv) => iv.end > iv.start);
      const merged = mergeIntervals(intervals);
      const badMinutes = merged.reduce((s, iv) => s + (iv.end - iv.start) / MINUTE_MS, 0);
      attainment[region][sli] = {
        badMinutes,
        attainmentPct: round((1 - badMinutes / window.minutes) * 100, 4),
        incidents: merged.flatMap((iv) => iv.ids),
      };
    }
  }
  return { window, classified, attainment };
}

export function reconcileWithMeasured(manifest, attainment) {
  const discrepancies = [];
  const measured = manifest.measuredAttainment?.values ?? {};
  const tolerance = manifest.policy.reconciliationTolerancePp;
  const rows = [];
  for (const region of manifest.regions) {
    for (const [sli, def] of Object.entries(manifest.policy.slis)) {
      const derived = attainment[region][sli].attainmentPct;
      const m = measured[region]?.[sli];
      const row = {
        region,
        sli,
        derived,
        measured: m ?? null,
        deltaPp: m == null ? null : round(m - derived, 4),
        derivedCreditPct: creditPctFor(derived, def.schedule),
        measuredCreditPct: m == null ? null : creditPctFor(m, def.schedule),
      };
      if (m == null) discrepancies.push(`${region} ${sli}: no measured attainment recorded`);
      else if (Math.abs(row.deltaPp) > tolerance) {
        discrepancies.push(
          `${region} ${sli}: incident-derived ${derived}% differs from measured ${m}% by ${Math.abs(row.deltaPp)}pp (tolerance ${tolerance}pp)`,
        );
      } else if (row.derivedCreditPct !== row.measuredCreditPct) {
        discrepancies.push(
          `${region} ${sli}: incident-derived credit ${row.derivedCreditPct}% disagrees with measured credit ${row.measuredCreditPct}%`,
        );
      }
      rows.push(row);
    }
  }
  return { rows, discrepancies };
}

export function buildLedger(manifest, attainment, planFees) {
  const { policy } = manifest;
  return manifest.consumers.map((c) => {
    const fee = c.monthlyFeeUsd ?? planFees[c.plan];
    if (!Number.isFinite(fee)) throw new Error(`consumer ${c.id}: no monthly fee for plan "${c.plan}"`);
    const eligible = policy.eligiblePlans.includes(c.plan);
    const lines = Object.entries(policy.slis).map(([sli, def]) => {
      const a = attainment[c.region]?.[sli];
      if (!a) throw new Error(`consumer ${c.id}: unknown region "${c.region}"`);
      const creditPct = eligible ? creditPctFor(a.attainmentPct, def.schedule) : 0;
      return { sli, attainmentPct: a.attainmentPct, objectivePct: def.objectivePct, creditPct, incidents: creditPct > 0 ? a.incidents : [] };
    });
    const uncappedPct = lines.reduce((s, l) => s + l.creditPct, 0);
    const creditPct = Math.min(uncappedPct, policy.monthlyCreditCapPct);
    return {
      consumerId: c.id,
      plan: c.plan,
      region: c.region,
      period: manifest.period,
      eligible,
      monthlyFeeUsd: fee,
      lines,
      uncappedPct,
      creditPct,
      capped: uncappedPct > creditPct,
      creditUsd: round((fee * creditPct) / 100, 2),
    };
  });
}

export function ledgerDigest(ledger) {
  return createHash('sha256').update(JSON.stringify(ledger)).digest('hex');
}

export function runServiceCredits(manifest, planFees) {
  const errors = validateIncidents(manifest);
  if (errors.length > 0) return { valid: false, errors };
  const { window, classified, attainment } = computeAttainment(manifest);
  const reconciliation = reconcileWithMeasured(manifest, attainment);
  const ledger = buildLedger(manifest, attainment, planFees);
  return {
    valid: reconciliation.discrepancies.length === 0,
    errors: reconciliation.discrepancies,
    window,
    classified,
    attainment,
    reconciliation,
    ledger,
    digest: ledgerDigest(ledger),
    totalCreditUsd: round(ledger.reduce((s, l) => s + l.creditUsd, 0), 2),
  };
}

function round(v, digits) {
  return Number(v.toFixed(digits));
}

function money(v) {
  return `$${v.toFixed(2)}`;
}

export function renderCreditReport(manifest, result) {
  const { policy } = manifest;
  const sliRows = Object.entries(policy.slis)
    .map(
      ([id, def]) =>
        `| ${def.label} (\`${id}\`) | ${def.objectivePct}% | ${def.schedule.map((b) => `< ${b.belowPct}% → ${b.creditPct}%`).join('; ')} |`,
    )
    .join('\n');
  return `# Service Credit Reconciliation (Issue #794)

An auditable method for associating eligible service incidents with consumer credits, with
every calculation verified against the delivery objectives in [service-sla.md](./service-sla.md).
Generated from \`config/service-credits.json\` (plan fees from \`config/sustainability-model.json\`)
by \`npm run credits:reconcile\`; do not edit by hand.

- **Owner**: ${manifest.owner}
- **Period**: ${manifest.period} (${result.window.minutes.toLocaleString('en-US')} minutes) · **Next review**: ${manifest.nextReviewDate}
- **Ledger digest (SHA-256)**: \`${result.digest}\`
- **Total credits issued**: ${money(result.totalCreditUsd)}

## Credit policy

| SLI | Objective | Credit schedule (% of monthly fee) |
| :--- | ---: | :--- |
${sliRows}

- Eligible plans: ${policy.eligiblePlans.join(', ')}. Credits for one month are capped at ${policy.monthlyCreditCapPct}% of that month's fee.
- Per-SLI credits take the highest matching band and are summed across SLIs before the cap.
- Excluded causes: ${policy.excludedCauses.join(', ')}. Scheduled maintenance is excluded only when announced at least ${policy.minimumMaintenanceNoticeHours}h ahead.
- Only resolved incidents count. Each classification must be approved by a second person.

## Method

1. **Classify**: each incident is checked against the exclusion rules (table below).
2. **Scope**: an eligible incident counts against every region it lists (\`*\` = all regions) for its SLI.
3. **Clip and merge**: incident windows are clipped to the period, and overlapping windows for the
   same region and SLI are merged so concurrent incidents are never counted twice.
4. **Attainment**: \`100 × (1 − bad minutes / minutes in period)\` per region and SLI.
5. **Reconcile**: the incident-derived attainment must be within ±${policy.reconciliationTolerancePp} percentage points of the
   measured SLO attainment and land in the same credit band. A mismatch means an incident is
   missing or mis-timed, and the check fails.
6. **Ledger**: each consumer's credit comes from their home region's attainment. The ledger is
   hashed so any later edit is detectable.

## Incident classification

| Incident | SLI | Regions | Window (UTC) | Cause | Eligible | Reason | Evidence | Classified / approved |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- | :--- |
${result.classified
  .map(
    (i) =>
      `| ${i.id} | ${i.sli} | ${i.regions.join(', ')} | ${i.startedAt} → ${i.endedAt} | ${i.cause} | ${i.eligible ? 'yes' : 'no'} | ${i.reason} | ${i.evidence} | ${i.classifiedBy} / ${i.approvedBy} |`,
  )
  .join('\n')}

## Attainment and reconciliation

Measured source: ${manifest.measuredAttainment.source}.

| Region | SLI | Bad minutes | Incident-derived | Measured | Δ (pp) | Credit (derived / measured) | Incidents |
| :--- | :--- | ---: | ---: | ---: | ---: | :---: | :--- |
${result.reconciliation.rows
  .map((r) => {
    const a = result.attainment[r.region][r.sli];
    return `| ${r.region} | ${r.sli} | ${a.badMinutes} | ${r.derived}% | ${r.measured ?? '—'}% | ${r.deltaPp ?? '—'} | ${r.derivedCreditPct}% / ${r.measuredCreditPct ?? '—'}% | ${a.incidents.join(', ') || '—'} |`;
  })
  .join('\n')}

Reconciliation result: ${result.reconciliation.discrepancies.length === 0 ? '**all region/SLI pairs agree within tolerance.**' : result.reconciliation.discrepancies.map((d) => `\n- ${d}`).join('')}

## Credit ledger

| Consumer | Plan | Region | Fee | ${Object.keys(policy.slis).join(' | ')} | Credit % | Credit | Incidents |
| :--- | :--- | :--- | ---: | ${Object.keys(policy.slis).map(() => '---:').join(' | ')} | ---: | ---: | :--- |
${result.ledger
  .map((l) => {
    const sliCells = l.lines.map((x) => `${x.attainmentPct}% → ${x.creditPct}%`).join(' | ');
    const incidents = [...new Set(l.lines.flatMap((x) => x.incidents))].join(', ') || '—';
    const pct = l.eligible ? `${l.creditPct}%${l.capped ? ' (capped)' : ''}` : 'not eligible';
    return `| ${l.consumerId} | ${l.plan} | ${l.region} | ${money(l.monthlyFeeUsd)} | ${sliCells} | ${pct} | **${money(l.creditUsd)}** | ${incidents} |`;
  })
  .join('\n')}

## Review procedure and completion evidence

1. After the month closes, the on-call primary records every resolved incident with SLI, regions,
   UTC window, cause and evidence; the reliability lead approves the classification.
2. Record the month's measured attainment from the SLO recording rules.
3. Run \`npm run credits:reconcile\`, commit the regenerated document, and hand the ledger and its
   digest to billing. Billing applies exactly the amounts in the ledger.

\`npm run credits:reconcile:check\` (run in CI) fails on an invalid or unapproved incident, an open
incident, a reconciliation mismatch, or a stale document. \`scripts/tests/service-credits.test.mjs\`
covers overlap merging, month-boundary clipping, exact objective boundaries, the maintenance
notice rule, the cap, ineligible plans, a missing incident caught by reconciliation, and ledger
tamper detection.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. It does not change the SLOs in service-sla.md; it makes the
  "service credits" section of that document calculable. No API, contract or schema changes.
- **Monitoring**: Inputs come from the existing SLO recording rules and incident postmortems.
  A reconciliation failure is itself the signal that incident records and telemetry disagree.
- **Operational impact**: Adds a monthly close step for on-call and billing (about 30 minutes).

## Rollout and rollback

- **Rollout**: Run the first close in shadow mode (ledger computed, credits not applied) and
  compare it with manual credit decisions. Switch billing to the ledger once one shadow month
  matches.
- **Rollback**: Revert the commit and return to manual credit decisions. Credits already applied
  stay applied; the committed ledgers and digests remain the audit record.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(creditsPath, 'utf8'));
  const sustainability = JSON.parse(await readFile(sustainabilityPath, 'utf8'));
  const planFees = Object.fromEntries(Object.entries(sustainability.revenueTiers).map(([k, v]) => [k, v.baseFeeMonthlyUsd]));
  const result = runServiceCredits(manifest, planFees);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.ledger) {
    for (const err of result.errors) console.error(`SERVICE_CREDIT_INVALID ${err}`);
    process.exit(1);
  }

  const rendered = renderCreditReport(manifest, result);

  if (args.includes('--check')) {
    let failed = false;
    for (const err of result.errors) {
      console.error(`SERVICE_CREDIT_RECONCILIATION ${err}`);
      failed = true;
    }
    let existing = '';
    try {
      existing = await readFile(reportPath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/SERVICE_CREDIT_RECONCILIATION.md is stale. Run: npm run credits:reconcile');
      failed = true;
    }
    if (failed) process.exit(1);
    console.log('Service credits reconcile with measured attainment and the document is up to date.');
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, reportPath)}: ${money(result.totalCreditUsd)} in credits for ${manifest.period}.`);
  for (const err of result.errors) console.warn(`warning: ${err}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
