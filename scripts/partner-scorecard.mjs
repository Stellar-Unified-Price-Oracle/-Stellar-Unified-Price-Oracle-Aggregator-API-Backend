#!/usr/bin/env node

/**
 * scripts/partner-scorecard.mjs — issue #797
 *
 * Scores ecosystem partners on integration quality, operational readiness,
 * security and support, and publishes the criteria, review process and current
 * results to docs/ECOSYSTEM_PARTNER_SCORECARD.md.
 *
 *   node scripts/partner-scorecard.mjs           # regenerate the report
 *   node scripts/partner-scorecard.mjs --check   # fail on an invalid config or stale report
 *   node scripts/partner-scorecard.mjs --json    # print scores
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'partner-scorecard.json');
const reportPath = path.join(root, 'docs', 'ECOSYSTEM_PARTNER_SCORECARD.md');

const COMPARISONS = new Set(['true', 'gte', 'lte']);

export function validateScorecard(card) {
  const errors = [];
  const cats = Object.entries(card.categories ?? {});
  if (cats.length === 0) errors.push('no categories defined');
  const totalWeight = cats.reduce((s, [, c]) => s + c.weight, 0);
  if (totalWeight !== 100) errors.push(`category weights sum to ${totalWeight}, expected 100`);
  const ids = new Set();
  for (const [key, c] of cats) {
    if (!Array.isArray(c.criteria) || c.criteria.length === 0) errors.push(`${key}: no criteria`);
    for (const cr of c.criteria ?? []) {
      if (ids.has(cr.id)) errors.push(`duplicate criterion id ${cr.id}`);
      ids.add(cr.id);
      if (!COMPARISONS.has(cr.comparison)) errors.push(`${cr.id}: unknown comparison ${cr.comparison}`);
      if (cr.comparison !== 'true' && !Number.isFinite(cr.threshold)) errors.push(`${cr.id}: numeric threshold required`);
      if (!(cr.weight > 0)) errors.push(`${cr.id}: weight must be > 0`);
      if (!cr.evidence) errors.push(`${cr.id}: evidence source required`);
    }
  }
  const mins = (card.ratings ?? []).map((r) => r.minScore);
  if (mins.length === 0 || mins.some((m, i) => i > 0 && m >= mins[i - 1]) || mins.at(-1) !== 0) {
    errors.push('ratings must be ordered by strictly descending minScore and end at 0');
  }
  return errors;
}

export function evaluateCriterion(cr, value) {
  if (value === undefined || value === null) return { status: 'missing', passed: false };
  if (cr.comparison === 'true') return { status: value === true ? 'pass' : 'fail', passed: value === true };
  if (!Number.isFinite(value)) return { status: 'missing', passed: false };
  const passed = cr.comparison === 'gte' ? value >= cr.threshold : value <= cr.threshold;
  return { status: passed ? 'pass' : 'fail', passed };
}

export function scorePartner(card, partner) {
  const categories = {};
  const criticalFailures = [];
  const missing = [];
  let overall = 0;

  for (const [key, cat] of Object.entries(card.categories)) {
    let earned = 0;
    let possible = 0;
    const results = cat.criteria.map((cr) => {
      const value = partner.evidence?.[cr.metric];
      const r = evaluateCriterion(cr, value);
      possible += cr.weight;
      if (r.passed) earned += cr.weight;
      if (r.status === 'missing') missing.push(cr.id);
      if (cr.critical && !r.passed) criticalFailures.push(cr.id);
      return { id: cr.id, metric: cr.metric, value: value ?? null, ...r, critical: cr.critical };
    });
    const score = possible > 0 ? (earned / possible) * 100 : 0;
    overall += score * (cat.weight / 100);
    categories[key] = { name: cat.name, score: Number(score.toFixed(1)), results };
  }

  overall = Number(overall.toFixed(1));
  const rating = card.ratings.find((r) => overall >= r.minScore && (!r.requiresAllCritical || criticalFailures.length === 0));
  return { id: partner.id, label: partner.label, reviewedAt: partner.reviewedAt, overall, rating: rating.name, categories, criticalFailures, missing };
}

export function nextReviewDate(card, reviewedAt) {
  const d = new Date(`${reviewedAt}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid reviewedAt: ${reviewedAt}`);
  d.setUTCMonth(d.getUTCMonth() + card.reviewCadence.fullReviewMonths);
  return d.toISOString().slice(0, 10);
}

function fmtThreshold(cr) {
  if (cr.comparison === 'true') return 'yes';
  return `${cr.comparison === 'gte' ? '≥' : '≤'} ${cr.threshold}`;
}

export function renderReport(card, scores) {
  const criteriaSections = Object.values(card.categories).map((cat) => `### ${cat.name} (weight ${cat.weight}%)

| Criterion | Metric | Pass when | Weight | Critical | Evidence |
| :--- | :--- | :--- | ---: | :---: | :--- |
${cat.criteria.map((cr) => `| \`${cr.id}\` | \`${cr.metric}\` | ${fmtThreshold(cr)} | ${cr.weight} | ${cr.critical ? 'yes' : ''} | ${cr.evidence} |`).join('\n')}`);

  const catKeys = Object.keys(card.categories);
  const resultRows = scores.map((s) => `| \`${s.id}\` | ${catKeys.map((k) => s.categories[k].score).join(' | ')} | **${s.overall}** | **${s.rating}** | ${nextReviewDate(card, s.reviewedAt)} |`);
  const findings = scores.map((s) => {
    const failed = Object.values(s.categories).flatMap((c) => c.results.filter((r) => !r.passed));
    const items = failed.length === 0
      ? '- All criteria met.'
      : failed.map((r) => `- \`${r.id}\`${r.critical ? ' (critical)' : ''}: ${r.status === 'missing' ? 'no evidence supplied' : `observed ${r.value}`}`).join('\n');
    return `### \`${s.id}\`\n\n_${s.label}_\n\n${items}`;
  });

  return `# Ecosystem Partner Scorecard (Issue #797)

This scorecard defines what "ready" means for an ecosystem partner, meaning any
protocol, wallet, SDK, or service that consumes the oracle in production. It
covers integration quality, operational readiness, security, and support. This
document is generated from \`config/partner-scorecard.json\` by
\`scripts/partner-scorecard.mjs\`. \`npm run partner-scorecard:check\` fails CI
when the criteria are invalid or this file is stale.

## Owner and scope

- **Owner**: ${card.owner} (${card.workstream} workstream)
- **Reviewers**: ${card.reviewers.join(', ')}
- **In scope**: Partners consuming production feeds through the REST/WS API or on-chain contract
- **Out of scope**: Upstream oracle providers, which are covered by docs/PROVIDER_ECOSYSTEM_READINESS.md

## Scoring

Each category score is the weighted share of its criteria that pass. The overall
score is the category-weighted average (0–100). Missing evidence counts as a
failure. A partner that fails any **critical** criterion can't be rated above
**${card.ratings.at(-1).name}**, whatever its score.

| Rating | Minimum score | All critical criteria must pass |
| :--- | ---: | :---: |
${card.ratings.map((r) => `| **${r.name}** | ${r.minScore} | ${r.requiresAllCritical ? 'yes' : 'no'} |`).join('\n')}

## Criteria

${criteriaSections.join('\n\n')}

## Review process

1. **Intake**: The partner registers a named technical contact and submits evidence for every metric.
   Evidence goes into \`config/partner-scorecard.json\` through a PR.
2. **Measurement**: Reviewers verify the evidence. Usage-derived metrics (429 rate, deprecated traffic,
   probe pass rate) come from our own analytics, not the partner's self-report.
3. **Scoring**: \`npm run partner-scorecard\` regenerates this report. The PR diff is the review record.
4. **Decision**: All reviewers sign off within ${card.reviewCadence.decisionSlaBusinessDays} business days. **Conditional** partners get an
   action list from the findings below and a re-review date no later than 90 days out.
5. **Re-review**: Full review every ${card.reviewCadence.fullReviewMonths} months, or sooner after ${card.reviewCadence.triggeredReviewOn.join(', ')}.
6. **Appeal**: A partner may supply new evidence at any time. The score is recomputed on the same criteria.

## Current results

| Partner | ${catKeys.map((k) => card.categories[k].name).join(' | ')} | Overall | Rating | Next review |
| :--- | ${catKeys.map(() => '---:').join(' | ')} | ---: | :--- | :--- |
${resultRows.join('\n')}

## Findings

${findings.join('\n\n')}

## Compatibility, monitoring, and operational impact

- **Compatibility**: Offline review tooling with no change to the API, the aggregator, or the contract. Ratings don't change rate limits or access by themselves.
- **Monitoring**: The usage metrics behind the scorecard already exist (usage analytics, 429 counters, readiness probe). Reviewers pull them at each review.
- **Operational impact**: None on the live price path.

## Rollout and rollback guidance

- **Rollout**: Score existing production partners first, without consequences, for one cycle. After that, use the rating for listing and support-priority decisions.
- **Rollback**: Revert the config and the script. Ratings are advisory and leave no persisted state.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const card = JSON.parse(await readFile(configPath, 'utf8'));
  const errors = validateScorecard(card);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  const scores = card.partners.map((p) => scorePartner(card, p));

  if (args.includes('--json')) {
    console.log(JSON.stringify(scores, null, 2));
    return;
  }

  const rendered = renderReport(card, scores);
  if (args.includes('--check')) {
    let existing = '';
    try {
      existing = await readFile(reportPath, 'utf8');
    } catch {}
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/ECOSYSTEM_PARTNER_SCORECARD.md is stale. Run: npm run partner-scorecard');
      process.exit(1);
    }
    console.log(`Partner scorecard OK (${scores.length} partner(s)).`);
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, reportPath)}`);
  for (const s of scores) console.log(`${s.id}: ${s.overall} ${s.rating}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
