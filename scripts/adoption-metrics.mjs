#!/usr/bin/env node

/**
 * scripts/adoption-metrics.mjs — issue #791
 *
 * Aggregate consumer adoption and retention metrics with privacy safeguards:
 * input minimization to an allow-list, salted HMAC pseudonyms, a weekly
 * activity ledger that holds no raw keys, k-anonymity suppression with
 * complementary suppression, count rounding, and a leak check that fails the
 * job if any key or pseudonym reaches the output.
 *
 *   node scripts/adoption-metrics.mjs                 regenerate docs/ADOPTION_METRICS.md
 *   node scripts/adoption-metrics.mjs --check         fail if the doc is stale
 *   ADOPTION_METRICS_SALT=... node scripts/adoption-metrics.mjs --input usage.ndjson
 *                                                     aggregate real UsageRecords to JSON on stdout
 */

import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRng } from './lib/oracle-economics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  config: path.join(root, 'config', 'adoption-metrics.json'),
  report: path.join(root, 'docs', 'ADOPTION_METRICS.md'),
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SYNTHETIC_SALT = 'synthetic-fixture-salt-not-for-production-use';

export function validateConfig(config) {
  const errors = [];
  if (!config?.owner) errors.push('owner is required');
  const p = config?.privacy ?? {};
  if (!(Number.isInteger(p.minCohortSize) && p.minCohortSize >= 2)) errors.push('privacy.minCohortSize must be an integer >= 2');
  if (!(Number.isInteger(p.roundCountsTo) && p.roundCountsTo >= 1)) errors.push('privacy.roundCountsTo must be an integer >= 1');
  if (!(p.minSaltLength >= 16)) errors.push('privacy.minSaltLength must be >= 16');
  if (!(p.rawEventRetentionDays > 0 && p.rawEventRetentionDays <= 30)) errors.push('privacy.rawEventRetentionDays must be in (0, 30]');
  const allowed = config?.input?.allowedFields ?? [];
  for (const forbidden of ['ip', 'userAgent', 'query', 'apiKey', 'email']) {
    if (allowed.includes(forbidden)) errors.push(`input.allowedFields must not include ${forbidden}`);
  }
  for (const m of config?.metrics ?? []) {
    if (!m.decision) errors.push(`metric ${m.id} must name the product decision it supports`);
  }
  if (errors.length) throw new Error(`Invalid adoption metrics config:\n- ${errors.join('\n- ')}`);
  return config;
}

export function createPseudonymizer(salt, config) {
  const p = config.privacy;
  if (typeof salt !== 'string' || salt.length < p.minSaltLength) {
    throw new Error(`${p.saltEnv} must be set to at least ${p.minSaltLength} characters`);
  }
  return (key) => createHmac('sha256', salt).update(String(key)).digest('hex').slice(0, p.pseudonymHexLength);
}

export function weekStart(timestampMs) {
  const d = new Date(timestampMs);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 24 * 60 * 60 * 1000;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Keep only allow-listed fields; report which other fields were discarded. */
export function minimizeRecord(raw, config) {
  const allowed = new Set(config.input.allowedFields);
  const dropped = Object.keys(raw ?? {}).filter((k) => !allowed.has(k));
  const kept = Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => allowed.has(k)));
  const timestamp = Number(kept.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || typeof kept.apiKeyPrefix !== 'string') {
    return { record: null, dropped };
  }
  return { record: { ...kept, timestamp }, dropped };
}

/**
 * Reduce raw usage records to a per-pseudonym weekly activity ledger. The
 * ledger is the only intermediate that may be retained beyond the raw-event
 * window; it holds pseudonyms, ISO weeks, tier and assets — no keys,
 * endpoints, IPs or request-level timestamps.
 */
export function buildActivityLedger(rawRecords, config, pseudonymize) {
  const [lo, hi] = config.input.activeStatusRange;
  const stats = { inputRecords: 0, invalidRecords: 0, anonymousRequests: 0, inactiveStatusRequests: 0, droppedFields: {} };
  const ledger = new Map();
  for (const raw of rawRecords) {
    stats.inputRecords++;
    const { record, dropped } = minimizeRecord(raw, config);
    for (const f of dropped) stats.droppedFields[f] = (stats.droppedFields[f] ?? 0) + 1;
    if (!record) {
      stats.invalidRecords++;
      continue;
    }
    if (record.apiKeyPrefix === config.input.anonymousKey) {
      stats.anonymousRequests++;
      continue;
    }
    const status = Number(record.status);
    if (!(status >= lo && status <= hi)) {
      stats.inactiveStatusRequests++;
      continue;
    }
    const p = pseudonymize(record.apiKeyPrefix);
    const week = weekStart(record.timestamp);
    const entry = ledger.get(p) ?? { weeks: new Set(), assets: new Set(), tier: null, firstWeek: week };
    entry.weeks.add(week);
    entry.firstWeek = Math.min(entry.firstWeek, week);
    if (record.asset) entry.assets.add(String(record.asset).toUpperCase());
    if (record.tier) entry.tier = String(record.tier);
    ledger.set(p, entry);
  }
  return { ledger, stats };
}

export function publishCount(n, privacy) {
  if (n < privacy.minCohortSize) return null;
  return Math.round(n / privacy.roundCountsTo) * privacy.roundCountsTo;
}

/**
 * k-anonymity suppression over one breakdown. With complementary suppression,
 * a single suppressed cell drags the next-smallest cell with it so it cannot
 * be recovered by subtracting the published cells from the published total.
 */
export function suppressBreakdown(counts, privacy) {
  const cells = Object.entries(counts)
    .map(([label, count]) => ({ label, count, suppressed: count < privacy.minCohortSize, complementary: false }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const suppressed = cells.filter((c) => c.suppressed);
  if (privacy.complementarySuppression && suppressed.length === 1 && cells.length > 1) {
    const next = cells.filter((c) => !c.suppressed).at(-1);
    next.suppressed = true;
    next.complementary = true;
  }
  return cells.map((c) => ({ label: c.label, value: c.suppressed ? null : publishCount(c.count, privacy), complementary: c.complementary }));
}

export function computeAdoptionMetrics(ledger, config) {
  const privacy = config.privacy;
  const population = ledger.size;
  if (population < privacy.minCohortSize) {
    return { insufficientPopulation: true, minCohortSize: privacy.minCohortSize };
  }
  const entries = [...ledger.values()];
  const allWeeks = entries.flatMap((e) => [...e.weeks]);
  const first = Math.min(...allWeeks);
  const last = Math.max(...allWeeks);
  const weeks = [];
  for (let w = first; w <= last; w += WEEK_MS) weeks.push(w);

  const weekly = weeks.map((w) => {
    const active = entries.filter((e) => e.weeks.has(w)).length;
    const fresh = entries.filter((e) => e.firstWeek === w).length;
    return { week: isoDate(w), activeRaw: active, newRaw: fresh };
  });
  const meanWeeklyActive = weekly.reduce((s, r) => s + r.activeRaw, 0) / weekly.length;

  const cohorts = weeks.map((w) => {
    const members = entries.filter((e) => e.firstWeek === w);
    const size = members.length;
    const retention = Object.fromEntries(
      config.retentionOffsetsWeeks.map((n) => {
        const target = w + n * WEEK_MS;
        if (target > last || size < privacy.minCohortSize) return [`w${n}`, null];
        return [`w${n}`, Math.round((members.filter((e) => e.weeks.has(target)).length / size) * 100) / 100];
      }),
    );
    return { cohort: isoDate(w), size: publishCount(size, privacy), retention };
  });

  const tally = (pick) => {
    const counts = {};
    for (const e of entries) for (const label of pick(e)) counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  };

  const feedAdoption = suppressBreakdown(tally((e) => [...e.assets]), privacy);
  const tierMix = suppressBreakdown(tally((e) => [e.tier ?? 'unknown']), privacy);

  const report = {
    period: { from: isoDate(first), to: isoDate(last + WEEK_MS - 1), weeks: weeks.length },
    distinctConsumers: publishCount(population, privacy),
    weekly: weekly.map((r) => ({ week: r.week, activeConsumers: publishCount(r.activeRaw, privacy), newConsumers: publishCount(r.newRaw, privacy) })),
    stickiness: Math.round((meanWeeklyActive / population) * 100) / 100,
    cohorts,
    feedAdoption,
    tierMix,
  };
  const suppressedCells =
    report.weekly.reduce((s, r) => s + (r.activeConsumers === null) + (r.newConsumers === null), 0) +
    cohorts.reduce((s, c) => s + (c.size === null), 0) +
    feedAdoption.filter((c) => c.value === null).length +
    tierMix.filter((c) => c.value === null).length;
  return { ...report, privacy: { minCohortSize: privacy.minCohortSize, roundCountsTo: privacy.roundCountsTo, suppressedCells } };
}

/** Every raw key and pseudonym that appears verbatim in the serialized output. */
export function findIdentifierLeaks(output, identifiers) {
  const text = (typeof output === 'string' ? output : JSON.stringify(output)).toLowerCase();
  return [...new Set(identifiers)].filter((id) => id && id.length >= 6 && text.includes(id.toLowerCase()));
}

export function runAdoptionMetrics(rawRecords, config, salt) {
  validateConfig(config);
  const pseudonymize = createPseudonymizer(salt, config);
  const { ledger, stats } = buildActivityLedger(rawRecords, config, pseudonymize);
  const metrics = computeAdoptionMetrics(ledger, config);
  const keys = rawRecords.map((r) => r?.apiKeyPrefix).filter((k) => typeof k === 'string' && k !== config.input.anonymousKey);
  const leaks = findIdentifierLeaks({ metrics, stats }, [...keys, ...ledger.keys()]);
  if (leaks.length) throw new Error(`Refusing to publish: ${leaks.length} consumer identifier(s) found in the output`);
  return { metrics, stats };
}

export function generateSyntheticUsage(seed = 791) {
  const rng = createRng(seed);
  const tiers = [
    { tier: 'free', count: 70, weeklyReturn: 0.45 },
    { tier: 'pro', count: 24, weeklyReturn: 0.82 },
    { tier: 'enterprise', count: 6, weeklyReturn: 0.97 },
  ];
  const assets = [['XLM', 0.5], ['USDC', 0.3], ['BTC', 0.15], ['EURC', 0.05]];
  const pickAsset = () => {
    let r = rng.next();
    for (const [a, w] of assets) if ((r -= w) <= 0) return a;
    return assets[0][0];
  };
  const origin = Date.UTC(2026, 6, 6);
  const totalWeeks = 16;
  const records = [];
  let n = 0;
  for (const { tier, count, weeklyReturn } of tiers) {
    for (let i = 0; i < count; i++) {
      const key = `sk${(n++).toString(16).padStart(6, '0')}`;
      const start = Math.floor(rng.next() * 8);
      let active = true;
      for (let w = start; w < totalWeeks && active; w++) {
        const requests = 1 + Math.floor(rng.next() * 3);
        for (let r = 0; r < requests; r++) {
          records.push({
            endpoint: '/api/v1/prices/:asset',
            method: 'GET',
            apiKeyPrefix: key,
            asset: pickAsset(),
            status: rng.bernoulli(0.05) ? 429 : 200,
            tier,
            ip: `203.0.113.${n % 250}`,
            userAgent: 'synthetic-client/1.0',
            timestamp: origin + w * WEEK_MS + Math.floor(rng.next() * WEEK_MS),
          });
        }
        active = rng.bernoulli(weeklyReturn);
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    records.push({ apiKeyPrefix: 'anonymous', asset: 'XLM', status: 200, timestamp: origin + Math.floor(rng.next() * totalWeeks * WEEK_MS) });
  }
  return records;
}

const cellValue = (v) => (v === null ? '<k' : String(v));
const rate = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function renderReport(config, example) {
  const p = config.privacy;
  const m = example.metrics;
  const offsets = config.retentionOffsetsWeeks;
  return `# Consumer Adoption and Retention Metrics (Issue #791)

Generated by \`npm run economics:adoption\` from \`config/adoption-metrics.json\`. Do not edit by
hand; \`npm run economics:adoption:check\` fails when this file is stale.

## Metric catalog

Every metric is an aggregate over API keys, never a per-consumer value, and names the
product decision it exists to support. A metric without a decision is rejected by config
validation.

| Metric | Definition | Decision it supports |
| :--- | :--- | :--- |
${config.metrics.map((x) => `| \`${x.id}\` | ${x.definition} | ${x.decision} |`).join('\n')}

"Active" means at least one request with status ${config.input.activeStatusRange[0]}–${config.input.activeStatusRange[1]}. Anonymous traffic is counted only as a
request total; it cannot be attributed and is never part of consumer counts.

## Privacy safeguards

| Control | Setting | Effect |
| :--- | :--- | :--- |
| Input allow-list | \`${config.input.allowedFields.join('`, `')}\` | All other fields (IP, user agent, endpoint, query) are discarded on read and only counted |
| Pseudonymization | HMAC-SHA256 with \`${p.saltEnv}\` (≥ ${p.minSaltLength} chars), truncated to ${p.pseudonymHexLength} hex | Raw key prefixes never leave the reader; the job refuses to run without a salt |
| Salt rotation | every ${p.saltRotationMonths} months | Old ledgers cannot be joined to new ones; retention history resets at rotation |
| Activity ledger | pseudonym → ISO weeks, tier, assets | The only retained intermediate; no keys, endpoints, IPs or request timestamps |
| k-anonymity | cells with fewer than ${p.minCohortSize} consumers are published as \`<k\` | Small cohorts, tiers and feeds cannot be singled out |
| Complementary suppression | ${p.complementarySuppression ? 'on' : 'off'} | A lone suppressed cell takes the next-smallest with it, so it cannot be derived from the total |
| Count rounding | to the nearest ${p.roundCountsTo} | Differencing two releases reveals less about single consumers |
| Retention rates | only for cohorts ≥ ${p.minCohortSize}, rounded to whole percent | Rates never describe a cohort smaller than k |
| Leak check | output scanned for every raw key and pseudonym | The job exits non-zero instead of publishing |
| Retention | raw events ${p.rawEventRetentionDays} days; ledger ${p.activityLedgerRetentionMonths} months; aggregates ${p.aggregateRetentionMonths} months | Raw events match \`TELEMETRY_RETENTION_DAYS\` in \`docs/privacy/telemetry-retention.md\` |

## Worked example (synthetic data)

The numbers below come from a seeded synthetic fixture (${example.stats.inputRecords} records, 100 keys over 16 weeks)
and exist only to show the output shape and suppression behaviour. **They are not production figures.**

Input handling: ${example.stats.anonymousRequests} anonymous requests excluded, ${example.stats.inactiveStatusRequests} non-success requests
excluded, ${example.stats.invalidRecords} invalid records; discarded fields: ${Object.entries(example.stats.droppedFields).map(([f, c]) => `\`${f}\` (${c})`).join(', ')}.

Distinct consumers: **${cellValue(m.distinctConsumers)}** · stickiness (mean weekly active / period active): **${rate(m.stickiness)}** · suppressed cells: **${m.privacy.suppressedCells}**.

### Weekly activity

| Week (UTC Monday) | Active consumers | New consumers |
| :--- | ---: | ---: |
${m.weekly.map((r) => `| ${r.week} | ${cellValue(r.activeConsumers)} | ${cellValue(r.newConsumers)} |`).join('\n')}

### Cohort retention

| Cohort (first week) | Cohort size | ${offsets.map((n) => `Week +${n}`).join(' | ')} |
| :--- | ---: | ${offsets.map(() => '---:').join(' | ')} |
${m.cohorts.map((c) => `| ${c.cohort} | ${cellValue(c.size)} | ${offsets.map((n) => rate(c.retention[`w${n}`])).join(' | ')} |`).join('\n')}

### Feed adoption and tier mix

| Asset | Consumers |
| :--- | ---: |
${m.feedAdoption.map((c) => `| ${c.label} | ${cellValue(c.value)}${c.complementary ? ' (complementary)' : ''} |`).join('\n')}

| Tier | Consumers |
| :--- | ---: |
${m.tierMix.map((c) => `| ${c.label} | ${cellValue(c.value)}${c.complementary ? ' (complementary)' : ''} |`).join('\n')}

## Running on real usage

\`\`\`
${p.saltEnv}=<secret from Vault> node scripts/adoption-metrics.mjs --input usage.ndjson > adoption.json
\`\`\`

\`usage.ndjson\` is one \`UsageRecord\` per line. Only the aggregate JSON is written to stdout; the
salt is read from the environment and never logged. Delete the raw export after the run.

## Review procedure and completion evidence

- \`node --test scripts/tests/adoption-metrics.test.mjs\` (run in CI) covers normal operation,
  boundaries (exactly k consumers, population below k, single suppressed cell, rounding) and failures
  (missing or short salt, forbidden input fields, a metric with no decision, an injected leak).
- \`npm run economics:adoption:check\` keeps this document in sync with the code.
- Quarterly (next: ${config.nextReviewDate}) the owner confirms each metric still drives its listed decision and
  removes any that do not.

## Owner, scope and limitations

- **Owner**: ${config.owner}.
- **Scope**: API-key–authenticated REST traffic recorded by \`usageTrackingMiddleware\`. WebSocket
  subscribers and on-chain contract readers are not covered.
- **Limitations**: an API key is not a customer (one integrator may hold several keys); "new" means
  first seen within the ledger, so retention history resets at each salt rotation; k-anonymity and
  rounding limit but do not eliminate inference across many releases.

## Compatibility, monitoring and operational impact

- **Compatibility**: offline job and documentation only. \`usage-tracking.ts\`, API responses,
  telemetry and the audit log are unchanged.
- **Monitoring**: each run reports discarded-field counts, suppressed-cell counts and anonymous
  request totals; a leak-check failure exits non-zero and should page the owner.
- **Operational impact**: none on serving paths; the job reads an export and needs no database access.

## Rollout and rollback

- **Rollout**: merge; provision \`${p.saltEnv}\` in Vault for the reporting job; run the first period
  manually and review suppressed cells before sharing.
- **Rollback**: stop the job and revert the commit; delete any activity ledger written under the
  current salt.
`;
}

function parseNdjson(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON on line ${i + 1}`);
      }
    });
}

async function main() {
  const args = process.argv.slice(2);
  const config = validateConfig(JSON.parse(await readFile(paths.config, 'utf8')));
  const inputIndex = args.indexOf('--input');
  if (inputIndex !== -1) {
    const file = args[inputIndex + 1];
    if (!file) throw new Error('--input requires a file path');
    const result = runAdoptionMetrics(parseNdjson(await readFile(file, 'utf8')), config, process.env[config.privacy.saltEnv]);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const example = runAdoptionMetrics(generateSyntheticUsage(), config, SYNTHETIC_SALT);
  const rendered = renderReport(config, example);
  if (args.includes('--check')) {
    const existing = await readFile(paths.report, 'utf8').catch(() => '');
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/ADOPTION_METRICS.md is stale. Run: npm run economics:adoption');
      process.exit(1);
    }
    console.log('Adoption metrics document is up to date.');
    return;
  }
  await writeFile(paths.report, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, paths.report)}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
