#!/usr/bin/env node

/**
 * scripts/historical-archive-tiers.mjs — issue #792
 *
 * Validates the tiered historical archive offering (config/historical-archive-tiers.json):
 * retention tiers, retrieval objectives, integrity guarantees and cost boundaries.
 * Generates docs/HISTORICAL_ARCHIVE_TIERS.md; `--check` fails when the plan is invalid
 * or the generated document is stale.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'historical-archive-tiers.json');
const envExamplePath = path.join(root, '.env.example');
const reportPath = path.join(root, 'docs', 'HISTORICAL_ARCHIVE_TIERS.md');

const SECONDS_PER_DAY = 86400;
const BYTES_PER_GIB = 1024 ** 3;

export function parseEnvDefaults(text) {
  const defaults = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) defaults[match[1]] = match[2].trim();
  }
  return defaults;
}

export function validateTierPlan(manifest, envDefaults = {}) {
  const errors = [];
  const tiers = manifest?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return ['manifest must define at least one tier'];
  }

  const policy = manifest.integrityPolicy ?? {};
  const allowed = new Set(policy.allowedChecksumAlgorithms ?? ['sha256']);

  if (tiers[0].ageFromDays !== 0) {
    errors.push(`first tier "${tiers[0].id}" must start at day 0, starts at ${tiers[0].ageFromDays}`);
  }

  tiers.forEach((tier, i) => {
    const label = `tier "${tier.id}"`;
    if (!(tier.ageToDays > tier.ageFromDays)) {
      errors.push(`${label}: ageToDays (${tier.ageToDays}) must exceed ageFromDays (${tier.ageFromDays})`);
    }
    if (!(tier.compressionRatio >= 1)) {
      errors.push(`${label}: compressionRatio must be >= 1`);
    }
    if (!(tier.retrieval?.objectiveP95Ms > 0)) {
      errors.push(`${label}: retrieval.objectiveP95Ms must be positive`);
    } else if (tier.retrieval.measuredP95Ms == null) {
      errors.push(`${label}: retrieval objective has no measurement evidence`);
    } else if (tier.retrieval.measuredP95Ms > tier.retrieval.objectiveP95Ms) {
      errors.push(
        `${label}: measured retrieval p95 ${tier.retrieval.measuredP95Ms} ms breaches objective ${tier.retrieval.objectiveP95Ms} ms`,
      );
    }

    const integrity = tier.integrity ?? {};
    if (!allowed.has(integrity.checksumAlgorithm)) {
      errors.push(`${label}: checksum algorithm "${integrity.checksumAlgorithm}" is not allowed`);
    }
    if (integrity.verifyOnWrite !== true) {
      errors.push(`${label}: integrity.verifyOnWrite must be true`);
    }
    if (!(integrity.scrubIntervalDays > 0) || integrity.scrubIntervalDays > (policy.maxScrubIntervalDays ?? 30)) {
      errors.push(`${label}: scrubIntervalDays must be between 1 and ${policy.maxScrubIntervalDays ?? 30}`);
    }
    if (
      !(integrity.restoreDrillIntervalDays > 0) ||
      integrity.restoreDrillIntervalDays > (policy.maxRestoreDrillIntervalDays ?? 90)
    ) {
      errors.push(`${label}: restoreDrillIntervalDays must be between 1 and ${policy.maxRestoreDrillIntervalDays ?? 90}`);
    }

    if (!(tier.cost?.storageUsdPerGibMonth >= 0) || !(tier.cost?.retrievalUsdPerGib >= 0)) {
      errors.push(`${label}: storage and retrieval rates must be non-negative`);
    }

    for (const binding of tier.envBindings ?? []) {
      if (binding.enforcement !== 'must-match-default') continue;
      const actual = envDefaults[binding.name];
      if (actual === undefined) {
        errors.push(`${label}: ${binding.name} is not documented in .env.example`);
      } else if (actual !== binding.value) {
        errors.push(`${label}: ${binding.name} default is ${actual} in .env.example, tier requires ${binding.value}`);
      }
    }

    if (i === 0) return;
    const prev = tiers[i - 1];
    if (tier.ageFromDays !== prev.ageToDays) {
      errors.push(
        `${label}: must start where "${prev.id}" ends (day ${prev.ageToDays}), starts at day ${tier.ageFromDays}`,
      );
    }
    if (tier.retrieval?.objectiveP95Ms < prev.retrieval?.objectiveP95Ms) {
      errors.push(`${label}: retrieval objective is tighter than the warmer tier "${prev.id}"`);
    }
    if (tier.cost?.storageUsdPerGibMonth > prev.cost?.storageUsdPerGibMonth) {
      errors.push(`${label}: storage rate is higher than the warmer tier "${prev.id}"`);
    }
    for (const plan of tier.plans ?? []) {
      if (!(prev.plans ?? []).includes(plan)) {
        errors.push(`${label}: plan "${plan}" has access without access to the warmer tier "${prev.id}"`);
      }
    }
  });

  return errors;
}

export function estimateTierFootprint(tier, volumeModel) {
  const { assets, cadenceSeconds, bytesPerPoint } = volumeModel;
  if (!(assets > 0) || !(cadenceSeconds > 0) || !(bytesPerPoint > 0)) {
    throw new Error('volumeModel requires positive assets, cadenceSeconds and bytesPerPoint');
  }
  const days = tier.ageToDays - tier.ageFromDays;
  const points = assets * (SECONDS_PER_DAY / cadenceSeconds) * days;
  const storedGib = (points * bytesPerPoint) / tier.compressionRatio / BYTES_PER_GIB;
  const monthlyStorageUsd = storedGib * tier.cost.storageUsdPerGibMonth;
  const retrievalUsdPerAssetYear =
    ((SECONDS_PER_DAY / cadenceSeconds) * 365 * bytesPerPoint * tier.cost.retrievalUsdPerGib) / BYTES_PER_GIB;
  return {
    days,
    points: Math.round(points),
    storedGib: Number(storedGib.toFixed(4)),
    monthlyStorageUsd: Number(monthlyStorageUsd.toFixed(4)),
    retrievalUsdPerAssetYear: Number(retrievalUsdPerAssetYear.toFixed(6)),
    withinCostCeiling: monthlyStorageUsd <= tier.cost.maxMonthlyUsd,
  };
}

export function evaluateArchivePlan(manifest, envDefaults = {}) {
  const errors = validateTierPlan(manifest, envDefaults);
  if (errors.length > 0) return { valid: false, errors, tiers: [], totals: null };

  const tiers = manifest.tiers.map((tier) => ({ ...tier, footprint: estimateTierFootprint(tier, manifest.volumeModel) }));
  const totalMonthlyStorageUsd = tiers.reduce((sum, t) => sum + t.footprint.monthlyStorageUsd, 0);
  const totalStoredGib = tiers.reduce((sum, t) => sum + t.footprint.storedGib, 0);
  const boundary = manifest.costBoundary ?? {};

  for (const t of tiers) {
    if (!t.footprint.withinCostCeiling) {
      errors.push(
        `tier "${t.id}": projected storage $${t.footprint.monthlyStorageUsd} exceeds ceiling $${t.cost.maxMonthlyUsd}`,
      );
    }
  }
  if (boundary.maxTotalMonthlyStorageUsd != null && totalMonthlyStorageUsd > boundary.maxTotalMonthlyStorageUsd) {
    errors.push(
      `total projected storage $${totalMonthlyStorageUsd.toFixed(4)} exceeds boundary $${boundary.maxTotalMonthlyStorageUsd}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    tiers,
    totals: {
      totalMonthlyStorageUsd: Number(totalMonthlyStorageUsd.toFixed(4)),
      totalStoredGib: Number(totalStoredGib.toFixed(4)),
      retentionDays: tiers[tiers.length - 1].ageToDays,
    },
  };
}

export function tierForAge(manifest, ageDays) {
  if (!(ageDays >= 0)) throw new Error('ageDays must be a non-negative number');
  return manifest.tiers.find((t) => ageDays >= t.ageFromDays && ageDays < t.ageToDays) ?? null;
}

export function digest(content, algorithm = 'sha256') {
  return createHash(algorithm).update(content).digest('hex');
}

export function verifyArchiveManifest(entries, readContent, algorithm = 'sha256') {
  const failures = [];
  for (const entry of entries) {
    let content;
    try {
      content = readContent(entry.file);
    } catch (err) {
      failures.push({ file: entry.file, reason: `unreadable: ${err.message}` });
      continue;
    }
    const actual = digest(content, algorithm);
    if (actual !== entry.checksum) {
      failures.push({ file: entry.file, reason: `checksum mismatch (expected ${entry.checksum}, got ${actual})` });
    }
  }
  return { verified: entries.length - failures.length, failures };
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${(ms / 3600000).toFixed(1)} h`;
}

function money(v, digits = 4) {
  return `$${v.toFixed(digits)}`;
}

function planLabel(plans) {
  return plans.map((p) => p[0].toUpperCase() + p.slice(1)).join(', ');
}

export function renderArchiveReport(manifest, plan) {
  const { tiers, totals } = plan;
  const vm = manifest.volumeModel;
  return `# Tiered Historical Archive Offering (Issue #792)

This document specifies the retention tiers, retrieval objectives, integrity guarantees and
cost boundaries for historical price data products. It is generated from
\`config/historical-archive-tiers.json\` by \`npm run archive:tiers\`; do not edit it by hand.

- **Owner**: ${manifest.owner}
- **Last updated**: ${manifest.updatedAt} · **Review interval**: ${manifest.reviewIntervalDays} days · **Next review**: ${manifest.nextReviewDate}

## Retention tiers

| Tier | Age window | Medium | Granularity | Plans |
| :--- | :--- | :--- | :--- | :--- |
${tiers
  .map(
    (t) =>
      `| **${t.name}** (\`${t.id}\`) | day ${t.ageFromDays} – ${t.ageToDays} | ${t.medium} | ${t.granularity} | ${planLabel(t.plans)} |`,
  )
  .join('\n')}

Tiers are contiguous: every age from day 0 to day ${totals.retentionDays} maps to exactly one tier, and
data older than day ${totals.retentionDays} is deleted. A plan with access to a colder tier always has
access to every warmer tier.

## Retrieval objectives

| Tier | Mode | Objective (p95) | Measured (p95) | Measured on | Evidence |
| :--- | :--- | ---: | ---: | :--- | :--- |
${tiers
  .map(
    (t) =>
      `| ${t.name} | ${t.retrieval.mode} | ${formatDuration(t.retrieval.objectiveP95Ms)} | ${formatDuration(t.retrieval.measuredP95Ms)} | ${t.retrieval.measuredOn} | ${t.retrieval.evidence} |`,
  )
  .join('\n')}

Online tiers are served by \`/api/v1/history\`. The cold tier is a restore request: the objective
is the time from an accepted request to the restored range being queryable.

## Integrity guarantees

| Tier | Checksum | Verify on write | Scrub interval | Restore drill | Immutable | Mechanism |
| :--- | :--- | :---: | ---: | ---: | :---: | :--- |
${tiers
  .map(
    (t) =>
      `| ${t.name} | ${t.integrity.checksumAlgorithm} | ${t.integrity.verifyOnWrite ? 'yes' : 'no'} | ${t.integrity.scrubIntervalDays} d | ${t.integrity.restoreDrillIntervalDays} d | ${t.integrity.immutable ? 'yes' : 'no'} | ${t.integrity.mechanism} |`,
  )
  .join('\n')}

Archive integrity is checked by \`verifyArchiveManifest\` in \`scripts/historical-archive-tiers.mjs\`:
every archive file is re-hashed and compared with its recorded checksum. A mismatch or an
unreadable file is reported as a failure and blocks the restore.

## Cost boundaries

Volume model: ${vm.assets} assets × one point per ${vm.cadenceSeconds}s × ${vm.bytesPerPoint} bytes per point.

| Tier | Days held | Points | Compression | Stored | Storage rate | Projected / month | Ceiling / month | Retrieval / asset-year |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${tiers
  .map(
    (t) =>
      `| ${t.name} | ${t.footprint.days} | ${t.footprint.points.toLocaleString('en-US')} | ${t.compressionRatio}× | ${t.footprint.storedGib} GiB | ${money(t.cost.storageUsdPerGibMonth, 3)}/GiB | ${money(t.footprint.monthlyStorageUsd)} | ${money(t.cost.maxMonthlyUsd, 2)} | ${money(t.footprint.retrievalUsdPerAssetYear, 6)} |`,
  )
  .join('\n')}
| **Total** | | | | **${totals.totalStoredGib} GiB** | | **${money(totals.totalMonthlyStorageUsd)}** | **${money(manifest.costBoundary.maxTotalMonthlyStorageUsd, 2)}** | |

Cold-tier retrieval is capped at ${manifest.costBoundary.maxRetrievalGibPerMonthPerConsumer} GiB per consumer per month. Requests above the cap
are queued to the next month or quoted separately.

## Configuration bindings

| Tier | Variable | Required value | Enforcement |
| :--- | :--- | :--- | :--- |
${tiers
  .flatMap((t) =>
    (t.envBindings ?? []).map(
      (b) =>
        `| ${t.name} | \`${b.name}\` | \`${b.value}\` | ${b.enforcement === 'must-match-default' ? 'Checked against `.env.example` in CI' : 'Set per environment at rollout'} |`,
    ),
  )
  .join('\n')}

## Review procedure and completion evidence

- \`npm run archive:tiers\` regenerates this document.
- \`npm run archive:tiers:check\` exits non-zero when tiers overlap or leave gaps, a measured retrieval
  p95 breaches its objective, an integrity control is missing or too infrequent, a projected cost
  exceeds its ceiling, a must-match variable drifts from \`.env.example\`, or this document is stale.
- \`scripts/tests/historical-archive-tiers.test.mjs\` covers normal, boundary (day 0, tier edges, final
  day) and failure cases (gaps, overlaps, breached objectives, checksum mismatch).
- Retrieval measurements are refreshed after each quarterly restore drill and k6 history run.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. The API's \`/api/v1/history\` contract is unchanged; the hot and warm
  tiers are the existing TimescaleDB hypertable. Plan gating for warm and cold ranges is a
  product decision to be enforced in the API in a follow-up.
- **Monitoring**: Track the existing archival logs (\`retention purged N cold file(s)\`), TimescaleDB
  chunk compression status, and storage spend through \`npm run cost:reconcile\`.
- **Operational impact**: None until the rollout settings are applied. Enabling
  \`HISTORY_RETENTION_DAYS=90\` drops database rows older than 90 days, so the cold archive must be
  enabled and verified first.

## Rollout and rollback

1. Enable \`FILE_ARCHIVAL_ENABLED=true\` with \`FILE_RETENTION_DAYS=2555\` and confirm the first archive
   pass writes checksummed files.
2. Run a restore drill and record the measured retrieval time in the config.
3. Only then set \`HISTORY_RETENTION_DAYS=90\` per environment.

**Rollback**: set \`HISTORY_RETENTION_DAYS=0\` to stop database pruning and \`FILE_ARCHIVAL_ENABLED=false\` to
stop archival. Data already archived stays restorable from cold storage. Reverting this commit
removes only the specification, script and document.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(configPath, 'utf8'));
  const envDefaults = parseEnvDefaults(await readFile(envExamplePath, 'utf8'));
  const plan = evaluateArchivePlan(manifest, envDefaults);

  if (args.includes('--json')) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (!plan.valid) {
    for (const err of plan.errors) console.error(`ARCHIVE_TIER_INVALID ${err}`);
    process.exit(1);
  }

  const rendered = renderArchiveReport(manifest, plan);

  if (args.includes('--check')) {
    let existing = '';
    try {
      existing = await readFile(reportPath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/HISTORICAL_ARCHIVE_TIERS.md is stale. Run: npm run archive:tiers');
      process.exit(1);
    }
    console.log('Historical archive tier plan is valid and the document is up to date.');
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, reportPath)} (${plan.tiers.length} tiers, $${plan.totals.totalMonthlyStorageUsd}/month projected).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
