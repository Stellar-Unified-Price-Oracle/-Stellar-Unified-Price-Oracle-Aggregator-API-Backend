import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  digest,
  estimateTierFootprint,
  evaluateArchivePlan,
  parseEnvDefaults,
  renderArchiveReport,
  tierForAge,
  validateTierPlan,
  verifyArchiveManifest,
} from '../historical-archive-tiers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function load() {
  const manifest = JSON.parse(await readFile(path.join(root, 'config', 'historical-archive-tiers.json'), 'utf8'));
  const env = parseEnvDefaults(await readFile(path.join(root, '.env.example'), 'utf8'));
  return { manifest, env };
}

function clone(value) {
  return structuredClone(value);
}

test('committed archive plan is valid against .env.example', async () => {
  const { manifest, env } = await load();
  const plan = evaluateArchivePlan(manifest, env);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.tiers.map((t) => t.id), ['hot', 'warm', 'cold']);
  assert.ok(plan.totals.totalMonthlyStorageUsd <= manifest.costBoundary.maxTotalMonthlyStorageUsd);
});

test('committed document matches the generator output', async () => {
  const { manifest, env } = await load();
  const rendered = renderArchiveReport(manifest, evaluateArchivePlan(manifest, env));
  const existing = await readFile(path.join(root, 'docs', 'HISTORICAL_ARCHIVE_TIERS.md'), 'utf8');
  assert.equal(existing.trim(), rendered.trim());
});

test('tierForAge resolves tier boundaries without gaps', async () => {
  const { manifest } = await load();
  assert.equal(tierForAge(manifest, 0).id, 'hot');
  assert.equal(tierForAge(manifest, 29.99).id, 'hot');
  assert.equal(tierForAge(manifest, 30).id, 'warm');
  assert.equal(tierForAge(manifest, 90).id, 'cold');
  assert.equal(tierForAge(manifest, 2554).id, 'cold');
  assert.equal(tierForAge(manifest, 2555), null);
  assert.throws(() => tierForAge(manifest, -1));
});

test('estimateTierFootprint computes points, storage and cost', () => {
  const tier = {
    ageFromDays: 0,
    ageToDays: 10,
    compressionRatio: 1,
    cost: { storageUsdPerGibMonth: 1, retrievalUsdPerGib: 0, maxMonthlyUsd: 1 },
  };
  const fp = estimateTierFootprint(tier, { assets: 1, cadenceSeconds: 86400, bytesPerPoint: 1024 ** 3 });
  assert.equal(fp.points, 10);
  assert.equal(fp.storedGib, 10);
  assert.equal(fp.monthlyStorageUsd, 10);
  assert.equal(fp.withinCostCeiling, false);
  assert.throws(() => estimateTierFootprint(tier, { assets: 0, cadenceSeconds: 30, bytesPerPoint: 1 }));
});

test('rejects gaps, overlaps and a first tier that does not start at day 0', async () => {
  const { manifest, env } = await load();
  const gap = clone(manifest);
  gap.tiers[1].ageFromDays = 31;
  assert.match(validateTierPlan(gap, env).join('\n'), /must start where "hot" ends/);

  const late = clone(manifest);
  late.tiers[0].ageFromDays = 1;
  assert.match(validateTierPlan(late, env).join('\n'), /must start at day 0/);

  const inverted = clone(manifest);
  inverted.tiers[2].ageToDays = 50;
  assert.match(validateTierPlan(inverted, env).join('\n'), /must exceed ageFromDays/);

  assert.deepEqual(validateTierPlan({ tiers: [] }), ['manifest must define at least one tier']);
});

test('rejects breached or unmeasured retrieval objectives', async () => {
  const { manifest, env } = await load();
  const breached = clone(manifest);
  breached.tiers[0].retrieval.measuredP95Ms = 501;
  assert.match(validateTierPlan(breached, env).join('\n'), /breaches objective 500 ms/);

  const atObjective = clone(manifest);
  atObjective.tiers[0].retrieval.measuredP95Ms = 500;
  assert.deepEqual(validateTierPlan(atObjective, env), []);

  const unmeasured = clone(manifest);
  delete unmeasured.tiers[2].retrieval.measuredP95Ms;
  assert.match(validateTierPlan(unmeasured, env).join('\n'), /no measurement evidence/);
});

test('rejects weak integrity controls and non-monotonic tiers', async () => {
  const { manifest, env } = await load();
  const weak = clone(manifest);
  weak.tiers[1].integrity.checksumAlgorithm = 'md5';
  weak.tiers[1].integrity.verifyOnWrite = false;
  weak.tiers[2].integrity.scrubIntervalDays = 31;
  const errors = validateTierPlan(weak, env).join('\n');
  assert.match(errors, /"md5" is not allowed/);
  assert.match(errors, /verifyOnWrite must be true/);
  assert.match(errors, /scrubIntervalDays must be between 1 and 30/);

  const pricier = clone(manifest);
  pricier.tiers[2].cost.storageUsdPerGibMonth = 1;
  assert.match(validateTierPlan(pricier, env).join('\n'), /storage rate is higher/);

  const planGap = clone(manifest);
  planGap.tiers[2].plans.push('free');
  assert.match(validateTierPlan(planGap, env).join('\n'), /plan "free" has access without access/);
});

test('detects drift between the plan and .env.example defaults', async () => {
  const { manifest, env } = await load();
  const drifted = { ...env, FILE_ARCHIVE_AFTER_DAYS: '60' };
  assert.match(validateTierPlan(manifest, drifted).join('\n'), /FILE_ARCHIVE_AFTER_DAYS default is 60/);
  const missing = { ...env };
  delete missing.FILE_ARCHIVE_AFTER_DAYS;
  assert.match(validateTierPlan(manifest, missing).join('\n'), /not documented in \.env\.example/);
});

test('evaluateArchivePlan flags cost ceiling breaches', async () => {
  const { manifest, env } = await load();
  const expensive = clone(manifest);
  expensive.volumeModel.assets = 500000;
  const plan = evaluateArchivePlan(expensive, env);
  assert.equal(plan.valid, false);
  assert.match(plan.errors.join('\n'), /exceeds ceiling/);
  assert.match(plan.errors.join('\n'), /exceeds boundary/);
});

test('verifyArchiveManifest detects checksum mismatches and unreadable files', () => {
  const files = { 'a.ndjson.gz': 'alpha', 'b.ndjson.gz': 'beta' };
  const read = (file) => {
    if (!(file in files)) throw new Error('ENOENT');
    return files[file];
  };
  const ok = verifyArchiveManifest(
    [
      { file: 'a.ndjson.gz', checksum: digest('alpha') },
      { file: 'b.ndjson.gz', checksum: digest('beta') },
    ],
    read,
  );
  assert.deepEqual(ok, { verified: 2, failures: [] });

  const bad = verifyArchiveManifest(
    [
      { file: 'a.ndjson.gz', checksum: digest('tampered') },
      { file: 'missing.ndjson.gz', checksum: digest('x') },
    ],
    read,
  );
  assert.equal(bad.verified, 0);
  assert.match(bad.failures[0].reason, /checksum mismatch/);
  assert.match(bad.failures[1].reason, /unreadable/);
});
