import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveObservations, nextDate, prioritize, renderReport, runReview, scoreDimensions, scoreKpi, validateReview } from '../roadmap-review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function readJson(name) {
  return JSON.parse(await readFile(path.join(root, 'config', name), 'utf8'));
}

async function sources() {
  return { sustainability: await readJson('sustainability-model.json'), partnerCard: await readJson('partner-scorecard.json') };
}

test('committed config is valid', async () => {
  assert.deepEqual(validateReview(await readJson('roadmap-review.json')), []);
});

test('validation catches weights, inverted targets and bad candidates', async () => {
  const bad = structuredClone(await readJson('roadmap-review.json'));
  bad.dimensions.economics.weight = 10;
  bad.dimensions.reliability.kpis[1].target = 900;
  bad.dimensions.security.kpis[0].floor = bad.dimensions.security.kpis[0].target;
  bad.candidates[0].dimensions = ['vibes'];
  bad.candidates[1].confidence = 0;
  bad.candidates[2].effort = 0;
  const errors = validateReview(bad).join('\n');
  assert.match(errors, /sum to 95/);
  assert.match(errors, /p95-latency-ms: target is on the wrong side/);
  assert.match(errors, /open-high-findings: floor and target must be distinct/);
  assert.match(errors, /third-party-publishers: unknown or missing dimension/);
  assert.match(errors, /partner-certification-drive: confidence/);
  assert.match(errors, /latency-budget: effort/);
});

test('KPI scoring is linear, clamped, direction-aware and null when missing', () => {
  const higher = { direction: 'higher', floor: 20, target: 60 };
  const lower = { direction: 'lower', floor: 500, target: 150 };
  assert.equal(scoreKpi(higher, 20), 0);
  assert.equal(scoreKpi(higher, 40), 50);
  assert.equal(scoreKpi(higher, 60), 100);
  assert.equal(scoreKpi(higher, 999), 100);
  assert.equal(scoreKpi(higher, -5), 0);
  assert.equal(scoreKpi(lower, 150), 100);
  assert.equal(scoreKpi(lower, 325), 50);
  assert.equal(scoreKpi(lower, 900), 0);
  assert.equal(scoreKpi(higher, undefined), null);
});

test('derived KPIs come from the sustainability model and exclude synthetic partners', async () => {
  const s = await sources();
  const derived = deriveObservations(s);
  assert.equal(derived['gross-margin-percent'], 97.8);
  assert.equal(derived['runway-months'], 14.4);
  assert.equal(derived['certified-partners'], 0);
  const real = structuredClone(s.partnerCard);
  real.partners[0].label = 'Production integrator';
  assert.equal(deriveObservations({ partnerCard: real })['certified-partners'], 1);
});

test('missing KPIs score zero and are reported', async () => {
  const review = await readJson('roadmap-review.json');
  const { dimensions } = scoreDimensions(review, {});
  for (const d of Object.values(dimensions)) {
    assert.equal(d.score, 0);
    assert.equal(d.missing.length, d.kpis.length);
  }
});

test('trend compares against the previous review when present', async () => {
  const review = structuredClone(await readJson('roadmap-review.json'));
  review.observations.previous.reliability = 80;
  const r = runReview(review, await sources());
  assert.equal(r.dimensions.reliability.trend, Number((r.dimensions.reliability.score - 80).toFixed(1)));
  assert.equal(r.dimensions.security.trend, null);
});

test('weaker dimensions raise priority for otherwise identical items', async () => {
  const review = structuredClone(await readJson('roadmap-review.json'));
  review.candidates = [
    { id: 'a', title: 'a', dimensions: ['reliability'], impact: 3, confidence: 0.5, effort: 3 },
    { id: 'b', title: 'b', dimensions: ['security'], impact: 3, confidence: 0.5, effort: 3 },
  ];
  const strongRel = { reliability: { score: 95 }, security: { score: 40 } };
  const ranked = prioritize(review, strongRel);
  assert.deepEqual(ranked.map((r) => r.id), ['b', 'a']);
  assert.equal(ranked[0].commitment, 'Commit');
});

test('ranking assigns Commit, Stretch and Backlog bands', async () => {
  const r = runReview(await readJson('roadmap-review.json'), await sources());
  assert.deepEqual(r.ranked.map((x) => x.commitment), ['Commit', 'Commit', 'Commit', 'Stretch', 'Stretch', 'Backlog', 'Backlog']);
  assert.ok(r.ranked.every((x, i, a) => i === 0 || a[i - 1].priority >= x.priority));
});

test('nextDate follows cadence and rejects bad dates', () => {
  assert.equal(nextDate('2026-11-19', 12), '2027-11-19');
  assert.equal(nextDate('2026-11-19', 3), '2027-02-19');
  assert.throws(() => nextDate('later', 3), /Invalid date/);
});

test('committed report matches the generator', async () => {
  const review = await readJson('roadmap-review.json');
  const rendered = renderReport(review, runReview(review, await sources()));
  const existing = await readFile(path.join(root, 'docs', 'POST_GA_ROADMAP_REVIEW.md'), 'utf8');
  assert.equal(existing.trim(), rendered.trim());
});
