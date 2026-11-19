#!/usr/bin/env node

/**
 * scripts/unit-economics.mjs — issue #795
 *
 * Comparable cost and margin measures by region and by feed. Every cost in the pool
 * (regional direct, feed direct, shared infrastructure) is attributed in both views, so the
 * two views reconcile to the same total. Shared costs carry an amount error band and an
 * allocation-key range, which together give a low/high cost and margin per region and feed.
 * Generates docs/REGIONAL_AND_FEED_UNIT_ECONOMICS.md.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { calculateRevenue } from './sustainability-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'unit-economics.json');
const feedCostPath = path.join(root, 'config', 'feed-cost-quality.json');
const sustainabilityPath = path.join(root, 'config', 'sustainability-model.json');
const reportPath = path.join(root, 'docs', 'REGIONAL_AND_FEED_UNIT_ECONOMICS.md');

const SHARE_EPSILON = 1e-6;
const REGION_KEYS = ['requests', 'vcpu', 'even'];
const FEED_KEYS = ['requests', 'submissions', 'even'];

function sum(values) {
  return values.reduce((s, v) => s + v, 0);
}

function normalize(weights) {
  const total = sum(Object.values(weights));
  if (!(total > 0)) throw new Error('allocation weights must sum to a positive number');
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / total]));
}

function checkShares(label, shares, errors) {
  const values = Object.values(shares);
  if (values.some((v) => !(v >= 0))) errors.push(`${label}: shares must be non-negative`);
  if (Math.abs(sum(values) - 1) > SHARE_EPSILON) errors.push(`${label}: shares sum to ${sum(values).toFixed(6)}, expected 1`);
}

export function validateUnitEconomics(config, feedCatalog) {
  const errors = [];
  const regions = config?.regions ?? [];
  if (regions.length === 0) errors.push('at least one region is required');
  checkShares('region revenueShare', Object.fromEntries(regions.map((r) => [r.id, r.revenueShare])), errors);
  checkShares('region requestsShare', Object.fromEntries(regions.map((r) => [r.id, r.requestsShare])), errors);
  for (const r of regions) {
    if (!(r.vcpu >= 0)) errors.push(`region ${r.id}: vcpu must be non-negative`);
    for (const c of r.directCosts ?? []) {
      if (!(c.usd >= 0)) errors.push(`region ${r.id} ${c.id}: usd must be non-negative`);
      if (!(c.errorBandPct >= 0 && c.errorBandPct <= 100)) errors.push(`region ${r.id} ${c.id}: errorBandPct must be 0..100`);
    }
  }

  const feedIds = (feedCatalog?.feeds ?? []).map((f) => f.feedId);
  const shareIds = Object.keys(config?.feeds?.requestsShare ?? {});
  for (const id of feedIds) if (!shareIds.includes(id)) errors.push(`feed ${id}: missing from feeds.requestsShare`);
  for (const id of shareIds) if (!feedIds.includes(id)) errors.push(`feed ${id}: not present in ${config.feeds.source}`);
  checkShares('feed requestsShare', config?.feeds?.requestsShare ?? {}, errors);
  for (const comp of config?.feeds?.directComponents ?? []) {
    for (const f of feedCatalog?.feeds ?? []) {
      if (!(f.costMetrics?.[comp.field] >= 0)) errors.push(`feed ${f.feedId}: ${comp.field} missing or negative`);
    }
  }

  for (const s of config?.sharedCosts ?? []) {
    if (!(s.usd >= 0)) errors.push(`shared ${s.id}: usd must be non-negative`);
    if (!(s.errorBandPct >= 0 && s.errorBandPct <= 100)) errors.push(`shared ${s.id}: errorBandPct must be 0..100`);
    for (const k of [s.regionKey, ...(s.regionAlternativeKeys ?? [])]) {
      if (!REGION_KEYS.includes(k)) errors.push(`shared ${s.id}: unknown region allocation key "${k}"`);
    }
    for (const k of [s.feedKey, ...(s.feedAlternativeKeys ?? [])]) {
      if (!FEED_KEYS.includes(k)) errors.push(`shared ${s.id}: unknown feed allocation key "${k}"`);
    }
  }
  const cross = config?.crossAllocation ?? {};
  for (const k of [cross.feedDirectToRegions?.key, ...(cross.feedDirectToRegions?.alternativeKeys ?? [])]) {
    if (!REGION_KEYS.includes(k)) errors.push(`crossAllocation.feedDirectToRegions: unknown key "${k}"`);
  }
  for (const k of [cross.regionDirectToFeeds?.key, ...(cross.regionDirectToFeeds?.alternativeKeys ?? [])]) {
    if (!FEED_KEYS.includes(k)) errors.push(`crossAllocation.regionDirectToFeeds: unknown key "${k}"`);
  }
  return errors;
}

export function shareVectors(config, feedCatalog) {
  const regions = config.regions;
  const feeds = feedCatalog.feeds;
  return {
    region: {
      requests: Object.fromEntries(regions.map((r) => [r.id, r.requestsShare])),
      vcpu: normalize(Object.fromEntries(regions.map((r) => [r.id, r.vcpu]))),
      even: Object.fromEntries(regions.map((r) => [r.id, 1 / regions.length])),
    },
    feed: {
      requests: { ...config.feeds.requestsShare },
      submissions: normalize(Object.fromEntries(feeds.map((f) => [f.feedId, f.monthlySubmissions]))),
      even: Object.fromEntries(feeds.map((f) => [f.feedId, 1 / feeds.length])),
    },
  };
}

export function banded(usd, errorBandPct) {
  return { point: usd, low: usd * (1 - errorBandPct / 100), high: usd * (1 + errorBandPct / 100) };
}

export function allocatePool(pool, primaryKey, alternativeKeys, vectors) {
  const keys = [primaryKey, ...(alternativeKeys ?? [])];
  const ids = Object.keys(vectors[primaryKey]);
  return Object.fromEntries(
    ids.map((id) => {
      const shares = keys.map((k) => vectors[k][id]);
      return [
        id,
        {
          point: pool.point * vectors[primaryKey][id],
          low: pool.low * Math.min(...shares),
          high: pool.high * Math.max(...shares),
        },
      ];
    }),
  );
}

function addRange(target, range) {
  target.point += range.point;
  target.low += range.low;
  target.high += range.high;
}

function emptyRange() {
  return { point: 0, low: 0, high: 0 };
}

function poolOf(ranges) {
  const pool = emptyRange();
  for (const r of ranges) addRange(pool, r);
  return pool;
}

export function totalRequests(sustainability) {
  const a = sustainability.assumptions;
  return sum(Object.keys(a.activeKeys).map((tier) => a.activeKeys[tier] * a.averageMonthlyRequestsPerKey[tier]));
}

export function computeUnitEconomics(config, feedCatalog, sustainability) {
  const errors = validateUnitEconomics(config, feedCatalog);
  if (errors.length > 0) return { valid: false, errors };

  const vectors = shareVectors(config, feedCatalog);
  const revenueTotal = calculateRevenue(sustainability).totalMonthlyRevenueUsd;
  const requestsTotal = totalRequests(sustainability);

  const regionDirect = Object.fromEntries(
    config.regions.map((r) => [r.id, r.directCosts.map((c) => ({ label: c.id, ...banded(c.usd, c.errorBandPct) }))]),
  );
  const feedDirect = Object.fromEntries(
    feedCatalog.feeds.map((f) => [
      f.feedId,
      config.feeds.directComponents.map((c) => ({ label: c.label, ...banded(f.costMetrics[c.field], c.errorBandPct) })),
    ]),
  );
  const regionDirectPool = poolOf(Object.values(regionDirect).flat());
  const feedDirectPool = poolOf(Object.values(feedDirect).flat());
  const sharedPools = config.sharedCosts.map((s) => ({ ...s, pool: banded(s.usd, s.errorBandPct) }));

  function buildView(dimension, ids, direct, crossPool, crossCfg, crossLabel, keyField, altField) {
    const crossAlloc = allocatePool(crossPool, crossCfg.key, crossCfg.alternativeKeys, vectors[dimension]);
    const sharedAllocs = sharedPools.map((s) => ({
      label: s.label,
      alloc: allocatePool(s.pool, s[keyField], s[altField], vectors[dimension]),
    }));
    return ids.map((id) => {
      const breakdown = [
        ...direct[id].map((d) => ({ kind: 'direct', label: d.label, point: d.point, low: d.low, high: d.high })),
        { kind: 'cross', label: crossLabel, ...crossAlloc[id] },
        ...sharedAllocs.map((s) => ({ kind: 'shared', label: s.label, ...s.alloc[id] })),
      ];
      return { id, breakdown, cost: poolOf(breakdown) };
    });
  }

  const regionView = buildView(
    'region',
    config.regions.map((r) => r.id),
    regionDirect,
    feedDirectPool,
    config.crossAllocation.feedDirectToRegions,
    'feed direct costs (allocated)',
    'regionKey',
    'regionAlternativeKeys',
  );
  const regionRows = regionView.map((row) => {
    const region = config.regions.find((r) => r.id === row.id);
    return finish(row, revenueTotal * region.revenueShare, requestsTotal * region.requestsShare, null);
  });

  const feedView = buildView(
    'feed',
    feedCatalog.feeds.map((f) => f.feedId),
    feedDirect,
    regionDirectPool,
    config.crossAllocation.regionDirectToFeeds,
    'regional direct costs (allocated)',
    'feedKey',
    'feedAlternativeKeys',
  );
  const feedRows = feedView.map((row) => {
    const feed = feedCatalog.feeds.find((f) => f.feedId === row.id);
    const share = config.feeds.requestsShare[row.id];
    return { ...finish(row, revenueTotal * share, requestsTotal * share, feed.monthlySubmissions), pair: feed.pair, cadenceSeconds: feed.cadenceSeconds };
  });

  const poolTotal = regionDirectPool.point + feedDirectPool.point + sum(sharedPools.map((s) => s.pool.point));
  const regionTotal = sum(regionView.map((r) => r.cost.point));
  const feedTotal = sum(feedView.map((r) => r.cost.point));
  const conservationErrors = [];
  for (const [label, total] of [['region view', regionTotal], ['feed view', feedTotal]]) {
    if (Math.abs(total - poolTotal) > 1e-6) {
      conservationErrors.push(`${label} attributes ${total.toFixed(4)} but the cost pool is ${poolTotal.toFixed(4)}`);
    }
  }
  const floorBreaches = [...regionRows, ...feedRows]
    .filter((r) => r.margin.lowPct < config.marginFloorPct)
    .map((r) => `${r.id}: low-case margin ${r.margin.lowPct}% is below the ${config.marginFloorPct}% floor`);

  return {
    valid: conservationErrors.length === 0 && floorBreaches.length === 0,
    errors: [...conservationErrors, ...floorBreaches],
    totals: {
      revenueUsd: revenueTotal,
      requests: requestsTotal,
      costPool: round(poolTotal),
      regionDirect: round(regionDirectPool.point),
      feedDirect: round(feedDirectPool.point),
      shared: round(sum(sharedPools.map((s) => s.pool.point))),
    },
    regions: regionRows,
    feeds: feedRows,
  };
}

function finish(row, revenue, requests, submissions) {
  const cost = { point: round(row.cost.point), low: round(row.cost.low), high: round(row.cost.high) };
  const marginPct = (c) => (revenue > 0 ? round(((revenue - c) / revenue) * 100, 2) : null);
  return {
    id: row.id,
    breakdown: row.breakdown.map((b) => ({ ...b, point: round(b.point), low: round(b.low), high: round(b.high) })),
    revenue: round(revenue),
    requests: Math.round(requests),
    cost,
    margin: {
      point: round(revenue - cost.point),
      low: round(revenue - cost.high),
      high: round(revenue - cost.low),
      pointPct: marginPct(cost.point),
      lowPct: marginPct(cost.high),
      highPct: marginPct(cost.low),
    },
    costPer1MRequests: {
      point: round((cost.point / requests) * 1e6),
      low: round((cost.low / requests) * 1e6),
      high: round((cost.high / requests) * 1e6),
    },
    costPer1kSubmissions: submissions ? round((cost.point / submissions) * 1000, 4) : null,
  };
}

function round(v, digits = 2) {
  return Number(v.toFixed(digits));
}

function money(v) {
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function rangeCell(r) {
  return `${money(r.point)} (${money(r.low)} – ${money(r.high)})`;
}

function breakdownTable(rows) {
  const labels = [...new Set(rows.flatMap((r) => r.breakdown.map((b) => b.label)))];
  return `| ${['Cost item', ...rows.map((r) => `\`${r.id}\``)].join(' | ')} |
| :--- | ${rows.map(() => '---:').join(' | ')} |
${labels
  .map((label) => {
    const kind = rows[0].breakdown.find((b) => b.label === label)?.kind;
    return `| ${label} *(${kind})* | ${rows.map((r) => money(r.breakdown.find((b) => b.label === label)?.point ?? 0)).join(' | ')} |`;
  })
  .join('\n')}
| **Total (point)** | ${rows.map((r) => `**${money(r.cost.point)}**`).join(' | ')} |`;
}

export function renderUnitEconomicsReport(config, result) {
  const t = result.totals;
  const keyList = (primary, alts) => `${primary}${alts?.length ? ` (range over ${alts.join(', ')})` : ''}`;
  return `# Regional and Feed Unit Economics (Issue #795)

Comparable cost and margin measures by region and by feed for ${config.period}, including
shared infrastructure allocation and its uncertainty. Generated from \`config/unit-economics.json\`,
\`config/feed-cost-quality.json\` and \`config/sustainability-model.json\` by \`npm run unit-economics\`;
do not edit by hand.

- **Owner**: ${config.owner}
- **Last updated**: ${config.updatedAt} · **Review interval**: ${config.reviewIntervalDays} days · **Next review**: ${config.nextReviewDate}

## Cost pool

| Component | Monthly cost | Notes |
| :--- | ---: | :--- |
| Regional direct (compute, storage, egress) | ${money(t.regionDirect)} | Attributed to the region that incurs it |
| Feed direct (${config.feeds.directComponents.map((c) => c.label).join(', ')}) | ${money(t.feedDirect)} | Attributed to the feed that incurs it |
| Shared infrastructure | ${money(t.shared)} | Allocated by key, see below |
| **Total** | **${money(t.costPool)}** | Both views below attribute exactly this total |

Revenue: ${money(t.revenueUsd)} per month across ${t.requests.toLocaleString('en-US')} requests (${config.revenue.source}).
${config.revenue.attribution}

Feed direct cost uses only feed-specific components from \`feed-cost-quality.json\`; that file's
aggregation-compute and storage figures are already inside the regional compute and storage, so
they are left out here to avoid counting them twice.

## Shared infrastructure allocation

| Shared cost | Amount | Error band | Region key | Feed key |
| :--- | ---: | ---: | :--- | :--- |
${config.sharedCosts
  .map(
    (s) =>
      `| ${s.label} | ${money(s.usd)} | ±${s.errorBandPct}% | ${keyList(s.regionKey, s.regionAlternativeKeys)} | ${keyList(s.feedKey, s.feedAlternativeKeys)} |`,
  )
  .join('\n')}
| Feed direct costs → regions | ${money(t.feedDirect)} | per component | ${keyList(config.crossAllocation.feedDirectToRegions.key, config.crossAllocation.feedDirectToRegions.alternativeKeys)} | — |
| Regional direct costs → feeds | ${money(t.regionDirect)} | per component | — | ${keyList(config.crossAllocation.regionDirectToFeeds.key, config.crossAllocation.regionDirectToFeeds.alternativeKeys)} |

**Uncertainty method.** Direct costs carry their own error band. For each allocated cost, the
low case takes the low end of the amount band times the smallest share any listed key would
assign, and the high case takes the high end times the largest share. Ranges are therefore
conservative: the low cases across regions do not sum to the pool's low case.

## Regions

| Region | Revenue | Cost (low – high) | Margin (low – high) | Margin % (low – high) | Requests | Cost / 1M requests (low – high) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
${result.regions
  .map(
    (r) =>
      `| \`${r.id}\` | ${money(r.revenue)} | ${rangeCell(r.cost)} | ${rangeCell(r.margin)} | ${r.margin.pointPct}% (${r.margin.lowPct}% – ${r.margin.highPct}%) | ${r.requests.toLocaleString('en-US')} | ${rangeCell(r.costPer1MRequests)} |`,
  )
  .join('\n')}

${breakdownTable(result.regions)}

## Feeds

| Feed | Pair | Cadence | Revenue | Cost (low – high) | Margin (low – high) | Margin % (low – high) | Cost / 1M requests | Cost / 1k submissions |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${result.feeds
  .map(
    (f) =>
      `| \`${f.id}\` | ${f.pair} | ${f.cadenceSeconds}s | ${money(f.revenue)} | ${rangeCell(f.cost)} | ${rangeCell(f.margin)} | ${f.margin.pointPct}% (${f.margin.lowPct}% – ${f.margin.highPct}%) | ${money(f.costPer1MRequests.point)} | ${money(f.costPer1kSubmissions)} |`,
  )
  .join('\n')}

${breakdownTable(result.feeds)}

## Reading the measures

- **Cost per 1M requests** compares regions and feeds of different size on one scale.
- **Cost per 1k submissions** compares feeds by on-chain publishing efficiency, independent of demand.
- **Margin %** is contribution margin over infrastructure, data and network costs only. Staff and
  overhead are not included.
- When two entities' margin ranges overlap, the data does not support ranking one above the
  other; tighten the allocation keys or error bands before acting on the difference.

## Review procedure and completion evidence

\`npm run unit-economics:check\` (run in CI) fails when shares do not sum to 1, the feeds here and in
\`feed-cost-quality.json\` diverge, an allocation key is unknown, either view fails to attribute
exactly the cost pool, a low-case margin falls below the ${config.marginFloorPct}% floor, or this document is
stale. \`scripts/tests/unit-economics.test.mjs\` covers conservation across both views, range
ordering, single-key and zero-band boundaries, and invalid inputs.

Monthly: update regional direct costs from the invoice split and request shares from usage
metrics, then regenerate.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. Reads \`feed-cost-quality.json\` and \`sustainability-model.json\`
  without changing them and reuses \`calculateRevenue\` from \`scripts/sustainability-model.mjs\`, so
  revenue cannot drift from the sustainability model.
- **Monitoring**: Inputs come from the existing cost reconciliation (\`npm run cost:reconcile\`) and
  per-region request metrics. A margin-floor failure is the signal to review regional pricing or
  feed cadence.
- **Operational impact**: None. Offline report; no runtime service reads these files.

## Rollout and rollback

- **Rollout**: Merge, then refresh inputs monthly as above.
- **Rollback**: Revert the commit. Nothing at runtime depends on it.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const [config, feedCatalog, sustainability] = await Promise.all(
    [configPath, feedCostPath, sustainabilityPath].map(async (p) => JSON.parse(await readFile(p, 'utf8'))),
  );
  const result = computeUnitEconomics(config, feedCatalog, sustainability);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.regions) {
    for (const err of result.errors) console.error(`UNIT_ECONOMICS_INVALID ${err}`);
    process.exit(1);
  }

  const rendered = renderUnitEconomicsReport(config, result);

  if (args.includes('--check')) {
    let failed = false;
    for (const err of result.errors) {
      console.error(`UNIT_ECONOMICS_CHECK ${err}`);
      failed = true;
    }
    let existing = '';
    try {
      existing = await readFile(reportPath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.trim() !== rendered.trim()) {
      console.error('docs/REGIONAL_AND_FEED_UNIT_ECONOMICS.md is stale. Run: npm run unit-economics');
      failed = true;
    }
    if (failed) process.exit(1);
    console.log('Regional and feed unit economics reconcile and the document is up to date.');
    return;
  }

  await writeFile(reportPath, rendered, 'utf8');
  console.log(`Generated ${path.relative(root, reportPath)}: cost pool ${money(result.totals.costPool)}, revenue ${money(result.totals.revenueUsd)}.`);
  for (const err of result.errors) console.warn(`warning: ${err}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
