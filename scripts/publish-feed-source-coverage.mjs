#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestArg = process.argv.indexOf('--manifest');
const manifestPath = manifestArg >= 0 ? path.resolve(process.argv[manifestArg + 1] ?? '') : path.join(root, 'scripts/feed-source-coverage.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const output = path.join(root, 'docs/feed-source-coverage.md');
const knownSources = ['chainlink', 'redstone', 'band', 'reflector'];
const expectedAssets = ['XLM', 'USDC', 'BTC', 'ETH', 'USDT'];
const errors = [];

const capabilitySource = fs.readFileSync(path.join(root, 'services/aggregator/src/oracle-sources/capabilities.ts'), 'utf8');
const watchedAssetsMatch = capabilitySource.match(/const WATCHED_ASSETS = \[([^\]]+)\]/);
const watchedAssets = watchedAssetsMatch ? [...watchedAssetsMatch[1].matchAll(/'([^']+)'/g)].map((asset) => asset[1]) : [];
const capabilitySources = [...capabilitySource.matchAll(/source: '(chainlink|redstone|band|reflector)',\s*\n\s*supportedAssets: \[\.\.\.WATCHED_ASSETS\]/g)].map((match) => match[1]);
if (!watchedAssetsMatch || new Set(capabilitySources).size !== knownSources.length || knownSources.some((source) => !capabilitySources.includes(source))) errors.push('unable to read all default provider capability profiles');
for (const asset of expectedAssets) if (!watchedAssets.includes(asset)) errors.push(`production asset ${asset} is absent from provider defaults`);
for (const asset of watchedAssets) if (!expectedAssets.includes(asset)) errors.push(`provider default asset ${asset} has no production coverage row`);

const overlayRoot = path.join(root, 'k8s/overlays');
const productionRegions = fs.readdirSync(overlayRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('prod-'))
  .map((entry) => entry.name.slice('prod-'.length)).sort();
if (!manifest.owner || !manifest.updatedAt) errors.push('owner and updatedAt are required');
if (JSON.stringify([...manifest.productionRegions].sort()) !== JSON.stringify(productionRegions)) errors.push('manifest productionRegions must exactly match production overlay directories');
if (!manifest.runtimeEvidence || !['not-measured', 'measured'].includes(manifest.runtimeEvidence.status)) errors.push('runtimeEvidence.status must be not-measured or measured');
if (manifest.runtimeEvidence?.status === 'measured' && (!manifest.runtimeEvidence.measuredAt || !manifest.runtimeEvidence.evidence)) errors.push('measured runtime evidence requires measuredAt and evidence');
if (!Array.isArray(manifest.feeds) || manifest.feeds.length !== expectedAssets.length) errors.push(`feeds must contain exactly ${expectedAssets.length} rows`);

const seenIds = new Set();
const seenAssets = new Set();
for (const feed of manifest.feeds ?? []) {
  if (!feed.feedId || seenIds.has(feed.feedId)) errors.push(`missing or duplicate feedId: ${feed.feedId ?? '<empty>'}`);
  seenIds.add(feed.feedId);
  if (!expectedAssets.includes(feed.asset) || seenAssets.has(feed.asset)) errors.push(`${feed.feedId}: unsupported or duplicate production asset ${feed.asset}`);
  seenAssets.add(feed.asset);
  if (!Array.isArray(feed.sources) || feed.sources.length === 0) errors.push(`${feed.feedId}: sources must be non-empty`);
  if (new Set(feed.sources ?? []).size !== (feed.sources ?? []).length) errors.push(`${feed.feedId}: duplicate sources`);
  for (const source of feed.sources ?? []) {
    if (!knownSources.includes(source)) errors.push(`${feed.feedId}: unknown source ${source}`);
    if (!watchedAssets.includes(feed.asset)) errors.push(`${feed.feedId}: ${feed.asset} is not supported by provider defaults`);
  }
  if (feed.quorum !== null && (!feed.quorum || !Number.isInteger(feed.quorum.minSources) || feed.quorum.minSources < 1 || feed.quorum.minSources > (feed.sources ?? []).length)) errors.push(`${feed.feedId}: quorum must be null or minSources within 1..provider count`);
  if (!Array.isArray(feed.limitations) || feed.limitations.length === 0 || feed.limitations.some((item) => !item.trim())) errors.push(`${feed.feedId}: limitations must contain at least one non-empty item`);
}
for (const asset of expectedAssets) if (!seenAssets.has(asset)) errors.push(`missing production feed for ${asset}`);
if (errors.length) {
  console.error(`Feed source coverage invalid:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

const rows = [...knownSources];
const table = [
  '| Feed | Asset | Default provider asset support | Production quorum | Active production regions | Runtime status | Known limitations |',
  '|---|---|---|---|---|---|---|',
  ...manifest.feeds.map((feed) => {
    const coverage = rows.map((source) => `${source}${feed.sources.includes(source) ? ' (supports asset by default)' : ' (not supported by default)'}`).join('<br>');
    return `| ${feed.feedId} | ${feed.asset}/USD | ${coverage} | ${feed.quorum ? `at least ${feed.quorum.minSources} sources` : 'not configured'} | ${productionRegions.join(', ')} (deployed overlays) | ${manifest.runtimeEvidence.status} | ${feed.limitations.join('<br>')} |`;
  }),
].join('\n');
const doc = `# Production feed source coverage\n\nOwner: ${manifest.owner}.\n\nGenerated from [feed-source-coverage.json](../scripts/feed-source-coverage.json) by \`npm run coverage:feeds\`. Manifest last reviewed: ${manifest.updatedAt}.\n\n${table}\n\n## Evidence and scope\n\nThe source column is validated against the aggregator's default asset capability profiles. Those profiles are not per-feed production eligibility policies. The repository has no persistent production feed policy store: API catalog policies are process-local, and no checked-in policy configures production quorum. Therefore quorum is shown as not configured unless a durable production policy is added. Regions are derived from production Kubernetes overlays; they identify deployed regions, not proof that every provider runs in each region. Runtime status is **${manifest.runtimeEvidence.status}**; this matrix does not claim live provider health or successful quotes. ${manifest.runtimeEvidence.limitations.join(' ')}\n\nFor a measured status, record the probe timestamp and evidence reference in the manifest. Evidence must report per-feed/per-region eligible providers observed during the same probe window.\n\n## Review procedure and completion evidence\n\nRun \`npm run coverage:feeds\` to regenerate, \`npm run coverage:feeds:check\` to verify the checked-in output, and \`npm run coverage:feeds:test\` to exercise normal, boundary, and invalid-manifest cases. Completion passes when these commands exit 0, all five default watched assets appear exactly once, each listed provider supports its asset in the source capability registry, and the region set matches production overlay directories. Negative cases cover missing feeds, unknown sources, quorum boundaries, and incomplete runtime evidence.\n\nReview this artifact whenever provider capability defaults, production overlays, feed eligibility, quorum, or runtime probe evidence changes.\n\n## Compatibility and operations\n\nThis is a generated documentation artifact; it does not change API responses, price calculation, provider polling, or on-chain publication. Monitor provider assignment rejection logs and existing quorum metrics when interpreting declared coverage. A provider configured to support an asset can still be unavailable at runtime.\n\n## Rollout and rollback\n\nRollout by regenerating and committing this matrix with its manifest after review. If generated output is incorrect, restore the prior manifest and regenerate; no service deployment or data migration is involved. If live behavior is affected by a source-policy change, revert the policy change through the feed catalog and use its existing versioned change log.\n`;
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== doc) {
    console.error('Feed source coverage is stale. Run npm run coverage:feeds.');
    process.exit(1);
  }
  console.log('Feed source coverage is current.');
} else {
  fs.writeFileSync(output, doc);
  console.log(`Wrote ${path.relative(root, output)}`);
}
