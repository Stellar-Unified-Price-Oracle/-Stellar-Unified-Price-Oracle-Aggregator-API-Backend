#!/usr/bin/env node

/**
 * scripts/roadmap-review.mjs — issue #798
 *
 * Annual post-GA roadmap review. Scores adoption, reliability, security,
 * economics and decentralization outcomes against floors and targets, then ranks
 * candidate roadmap items so work on the weakest dimensions comes first.
 * Renders docs/POST_GA_ROADMAP_REVIEW.md.
 *
 * Economics KPIs come from scripts/sustainability-model.mjs and the certified
 * partner count from scripts/partner-scorecard.mjs, so the review cannot drift
 * from those models.
 *
 *   node scripts/roadmap-review.mjs           # regenerate the report
 *   node scripts/roadmap-review.mjs --check   # fail on an invalid config or stale report
 *   node scripts/roadmap-review.mjs --json    # print the review
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runSustainabilityAnalysis } from './sustainability-model.mjs';
import { scorePartner } from './partner-scorecard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, 'docs', 'POST_GA_ROADMAP_REVIEW.md');

async function readJson(name) {
  return JSON.parse(await readFile(path.join(root, 'config', name), 'utf8'));
}

export function validateReview(review) {
  const errors = [];
  const dims = Object.entries(review.dimensions ?? {});
  const total = dims.reduce((s, [, d]) => s + d.weight, 0);
  if (total !== 100) errors.push(`dimension weights sum to ${total}, expected 100`);
  for (const [key, d] of dims) {
    if (!Array.isArray(d.kpis) || d.kpis.length === 0) errors.push(`${key}: no KPIs`);
    for (const k of d.kpis ?? []) {
      if (!['higher', 'lower'].includes(k.direction)) errors.push(`${k.id}: direction must be higher or lower`);
      if (!Number.isFinite(k.floor) || !Number.isFinite(k.target) || k.floor === k.target) errors.push(`${k.id}: floor and target must be distinct numbers`);
      else if ((k.direction === 'higher') !== (k.target > k.floor)) errors.push(`${k.id}: target is on the wrong side of floor for direction ${k.direction}`);
    }
  }
  for (const c of review.candidates ?? []) {
    if (!c.dimensions?.length || c.dimensions.some((d) => !review.dimensions[d])) errors.push(`${c.id}: unknown or missing dimension`);
    if (!(c.impact >= 1 && c.impact <= 5)) errors.push(`${c.id}: impact must be 1-5`);
    if (!(c.confidence > 0 && c.confidence <= 1)) errors.push(`${c.id}: confidence must be in (0, 1]`);
    if (!(c.effort > 0)) errors.push(`${c.id}: effort must be > 0`);
  }
  return errors;
}

export function scoreKpi(kpi, value) {
  if (!Number.isFinite(value)) return null;
  const progress = (value - kpi.floor) / (kpi.target - kpi.floor);
  return Number((Math.min(1, Math.max(0, progress)) * 100).toFixed(1));
}

export function deriveObservations({ sustainability, partnerCard }) {
  const values = {};
  if (sustainability) {
    const baseline = runSustainabilityAnalysis(sustainability).baseline;
    values['gross-margin-percent'] = baseline.grossMarginPercent;
    values['runway-months'] = baseline.runwayMonths;
  }
  if (partnerCard) {
    values['certified-partners'] = partnerCard.partners
      .filter((p) => !/synthetic/i.test(p.label ?? ''))
      .map((p) => scorePartner(partnerCard, p))
      .filter((s) => s.rating === 'Certified').length;
  }
  return values;
}

export function scoreDimensions(review, values) {
  const dimensions = {};
  let overall = 0;
  for (const [key, d] of Object.entries(review.dimensions)) {
    const kpis = d.kpis.map((k) => ({ ...k, value: values[k.id] ?? null, score: scoreKpi(k, values[k.id]) }));
    const missing = kpis.filter((k) => k.score === null).map((k) => k.id);
    const score = Number((kpis.reduce((s, k) => s + (k.score ?? 0), 0) / kpis.length).toFixed(1));
    const prev = review.observations?.previous?.[key];
    dimensions[key] = { name: d.name, weight: d.weight, score, kpis, missing, trend: Number.isFinite(prev) ? Number((score - prev).toFixed(1)) : null };
    overall += score * (d.weight / 100);
  }
  return { dimensions, overall: Number(overall.toFixed(1)) };
}

export function prioritize(review, dimensions) {
  return review.candidates
    .map((c) => {
      const gap = Math.max(...c.dimensions.map((d) => (100 - dimensions[d].score) * (review.dimensions[d].weight / 100)));
      const priority = Number(((c.impact * c.confidence * (1 + gap / 10)) / c.effort).toFixed(3));
      return { ...c, gap: Number(gap.toFixed(1)), priority };
    })
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map((c, i) => ({ ...c, rank: i + 1, commitment: i < 3 ? 'Commit' : i < 5 ? 'Stretch' : 'Backlog' }));
}

export function nextDate(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${isoDate}`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function runReview(review, sources = {}) {
  const derived = deriveObservations(sources);
  const values = { ...review.observations.values, ...derived };
  const { dimensions, overall } = scoreDimensions(review, values);
  const ranked = prioritize(review, dimensions);
  return { values, derived: Object.keys(derived), dimensions, overall, ranked };
}

function fmt(v) {
  return v === null || v === undefined ? 'missing' : v;
}

export function renderReport(review, result) {
  const c = review.cadence;
  const dimRows = Object.values(result.dimensions).map((d) => `| ${d.name} | ${d.weight}% | **${d.score}** | ${d.trend === null ? 'baseline year' : d.trend} | ${d.missing.length ? d.missing.map((m) => `\`${m}\``).join(', ') : '—'} |`);
  const kpiSections = Object.values(result.dimensions).map((d) => `### ${d.name}

| KPI | Floor (0) | Target (100) | Observed | Score | Source |
| :--- | ---: | ---: | ---: | ---: | :--- |
${d.kpis.map((k) => `| \`${k.id}\`${result.derived.includes(k.id) ? ' †' : ''} | ${k.floor} ${k.unit} | ${k.target} ${k.unit} | ${fmt(k.value)} | ${fmt(k.score)} | ${k.source} |`).join('\n')}`);
  const roadmapRows = result.ranked.map((r) => `| ${r.rank} | \`${r.id}\` | ${r.title} | ${r.dimensions.join(', ')} | ${r.impact} | ${r.confidence} | ${r.effort} | ${r.gap} | ${r.priority} | **${r.commitment}** |`);

  return `# Post-GA Roadmap Review — ${c.period} (Issue #798)

A yearly review that scores five outcome dimensions and turns the gaps into a
ranked roadmap. It's generated from \`config/roadmap-review.json\` by
\`scripts/roadmap-review.mjs\`. \`npm run roadmap-review:check\` fails CI when the
config is invalid or this file is stale.

## Owner, cadence, and scope

- **Owner**: ${review.owner} (${review.workstream} workstream). **Facilitator**: ${review.facilitator}
- **Participants**: ${review.participants.join(', ')}
- **Cadence**: Full review every ${c.fullReviewMonths} months, with KPI checkpoints every ${c.checkpointMonths} months
- **This review**: ${c.reviewDate}. **Next checkpoint**: ${nextDate(c.reviewDate, c.checkpointMonths)}. **Next full review**: ${nextDate(c.reviewDate, c.fullReviewMonths)}
- **Inputs**: ${review.observations.label}

## Scoring method

Each KPI scores linearly from 0 at its **floor** to 100 at its **target**,
clamped to that range. A missing KPI scores 0 and is listed, so absent evidence
lowers the score rather than being hidden. A dimension's score is the mean of
its KPIs. The overall score is the weighted mean of the dimensions.

† marks a derived KPI: \`gross-margin-percent\` and \`runway-months\` come from
\`npm run sustainability:model\`, and \`certified-partners\` from
\`npm run partner-scorecard\`, counting only real partners.

## Outcome scores

**Overall: ${result.overall} / 100**

| Dimension | Weight | Score | Δ vs. last review | Missing evidence |
| :--- | ---: | ---: | :--- | :--- |
${dimRows.join('\n')}

${kpiSections.join('\n\n')}

## Prioritized roadmap input

Priority = impact × confidence × (1 + gap ÷ 10) ÷ effort. The gap is the largest
weighted shortfall (100 − score) × weight across the item's dimensions, so work
on weak, heavily weighted dimensions rises. The top 3 items are proposed as
commitments for next year's roadmap, the next 2 as stretch goals, and the rest
stay in the backlog.

| Rank | Item | Title | Dimensions | Impact | Confidence | Effort | Gap | Priority | Proposal |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
${roadmapRows.join('\n')}

## Review procedure

1. **Four weeks before**: Owners refresh measured values in \`config/roadmap-review.json\`, regenerate the
   sustainability model and partner scorecard, and propose candidate items.
2. **Review session**: Participants challenge the KPI values and the impact, confidence, and effort estimates,
   then regenerate this report. The committed diff is the record.
3. **Hand-off**: Items marked Commit become roadmap epics, each with an owner and a target KPI.
   Last year's dimension scores are copied into \`observations.previous\` to show the trend.
4. **Checkpoints**: Every ${c.checkpointMonths} months, update KPI values only. A dimension that falls more than 10 points
   triggers an out-of-cycle reprioritization.

## Compatibility, monitoring, and operational impact

- **Compatibility**: Offline tooling that reads the existing sustainability and partner models, with no runtime, API, or contract change.
- **Monitoring**: Every KPI names its source. Reliability and security values come from the existing SLO, gap-detection, and audit tooling.
- **Operational impact**: None on the live price path.

## Rollout and rollback guidance

- **Rollout**: Run the first review with the illustrative inputs replaced by measured values. The first year has no trend.
- **Rollback**: Revert the config and the script. Nothing is persisted outside git.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const review = await readJson('roadmap-review.json');
  const errors = validateReview(review);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  const result = runReview(review, {
    sustainability: await readJson('sustainability-model.json'),
    partnerCard: await readJson('partner-scorecard.json'),
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const rendered = renderReport(review, result);
  if (args.includes('--check')) {
    let existing = '';
    try {
      existing = await readFile(reportPath, 'utf8');
    } catch {}
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/POST_GA_ROADMAP_REVIEW.md is stale. Run: npm run roadmap-review');
      process.exit(1);
    }
    console.log(`Roadmap review OK (overall ${result.overall}).`);
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, reportPath)} (overall ${result.overall})`);
  for (const r of result.ranked.slice(0, 5)) console.log(`${r.rank}. ${r.id} (${r.commitment})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
