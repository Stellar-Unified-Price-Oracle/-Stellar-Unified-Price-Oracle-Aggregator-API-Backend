import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCriterion, nextReviewDate, renderReport, scorePartner, validateScorecard } from '../partner-scorecard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function load() {
  return JSON.parse(await readFile(path.join(root, 'config', 'partner-scorecard.json'), 'utf8'));
}

function perfectEvidence(card) {
  const ev = {};
  for (const cat of Object.values(card.categories)) {
    for (const cr of cat.criteria) ev[cr.metric] = cr.comparison === 'true' ? true : cr.threshold;
  }
  return ev;
}

test('committed config is valid', async () => {
  assert.deepEqual(validateScorecard(await load()), []);
});

test('validation catches bad weights, comparisons, thresholds and rating order', async () => {
  const card = await load();
  const bad = structuredClone(card);
  bad.categories.support.weight = 10;
  bad.categories.security.criteria[0].comparison = 'between';
  bad.categories.security.criteria[1].threshold = undefined;
  bad.categories.support.criteria[0].evidence = '';
  bad.ratings = [{ name: 'A', minScore: 50 }, { name: 'B', minScore: 60 }];
  const errors = validateScorecard(bad).join('\n');
  assert.match(errors, /sum to 95/);
  assert.match(errors, /unknown comparison between/);
  assert.match(errors, /key-rotation: numeric threshold/);
  assert.match(errors, /named-contact: evidence source/);
  assert.match(errors, /strictly descending/);
});

test('thresholds are inclusive and missing or non-numeric evidence fails', () => {
  assert.equal(evaluateCriterion({ comparison: 'lte', threshold: 90 }, 90).passed, true);
  assert.equal(evaluateCriterion({ comparison: 'lte', threshold: 90 }, 91).passed, false);
  assert.equal(evaluateCriterion({ comparison: 'gte', threshold: 99 }, 99).passed, true);
  assert.equal(evaluateCriterion({ comparison: 'true' }, 'yes').passed, false);
  assert.equal(evaluateCriterion({ comparison: 'gte', threshold: 1 }, undefined).status, 'missing');
  assert.equal(evaluateCriterion({ comparison: 'gte', threshold: 1 }, 'abc').status, 'missing');
});

test('evidence exactly at every threshold scores 100 and is Certified', async () => {
  const card = await load();
  const s = scorePartner(card, { id: 'p', reviewedAt: '2026-01-01', evidence: perfectEvidence(card) });
  assert.equal(s.overall, 100);
  assert.equal(s.rating, 'Certified');
});

test('one critical failure caps the rating even with a high score', async () => {
  const card = await load();
  const ev = { ...perfectEvidence(card), keyRotationDays: 91 };
  const s = scorePartner(card, { id: 'p', reviewedAt: '2026-01-01', evidence: ev });
  assert.ok(s.overall >= 85);
  assert.deepEqual(s.criticalFailures, ['key-rotation']);
  assert.equal(s.rating, 'Not ready');
});

test('non-critical gaps drop a partner to Conditional', async () => {
  const card = await load();
  const ev = { ...perfectEvidence(card), readinessProbePassRatePercent: 90, onSupportedSdkVersion: false, alertsOnStaleness: false, monthsSinceSecurityAudit: 30 };
  const s = scorePartner(card, { id: 'p', reviewedAt: '2026-01-01', evidence: ev });
  assert.equal(s.criticalFailures.length, 0);
  assert.ok(s.overall >= 70 && s.overall < 85, `overall ${s.overall}`);
  assert.equal(s.rating, 'Conditional');
});

test('a partner with no evidence is Not ready with everything missing', async () => {
  const card = await load();
  const s = scorePartner(card, { id: 'p', reviewedAt: '2026-01-01', evidence: {} });
  assert.equal(s.overall, 0);
  assert.equal(s.rating, 'Not ready');
  assert.equal(s.missing.length, Object.values(card.categories).reduce((n, c) => n + c.criteria.length, 0));
});

test('example partners land in the expected ratings', async () => {
  const card = await load();
  const [lending, wallet] = card.partners.map((p) => scorePartner(card, p));
  assert.equal(lending.rating, 'Certified');
  assert.equal(wallet.rating, 'Not ready');
  assert.ok(wallet.criticalFailures.includes('key-rotation'));
  assert.ok(wallet.missing.includes('recent-audit'));
});

test('next review date follows the cadence and rejects bad dates', async () => {
  const card = await load();
  assert.equal(nextReviewDate(card, '2026-11-19'), '2027-11-19');
  assert.throws(() => nextReviewDate(card, 'soon'), /Invalid reviewedAt/);
});

test('committed report matches the generator', async () => {
  const card = await load();
  const rendered = renderReport(card, card.partners.map((p) => scorePartner(card, p)));
  const existing = await readFile(path.join(root, 'docs', 'ECOSYSTEM_PARTNER_SCORECARD.md'), 'utf8');
  assert.equal(existing.trim(), rendered.trim());
});
