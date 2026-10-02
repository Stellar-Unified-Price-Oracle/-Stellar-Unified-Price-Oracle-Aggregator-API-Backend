#!/usr/bin/env node
/**
 * scripts/check-route-contract.mjs  — issue #620
 *
 * Reconciles the Express route mounts in api/src/index.ts against the paths
 * declared in api/openapi.json, and reports any gap in either direction.
 *
 * Exit 0 — every mounted prefix has a matching OpenAPI path group, and every
 *           OpenAPI path group has a matching mount (outside the ignore lists).
 * Exit 1 — at least one route is mounted-but-undocumented or
 *           documented-but-unmounted.
 *
 * How "route groups" work
 * -----------------------
 * Express mounts a router at a prefix (e.g. app.use('/api/v1', v1Routes)).
 * OpenAPI paths are full paths (e.g. /api/v1/prices). We reconcile at the
 * prefix level: a mounted prefix is "covered" if at least one OpenAPI path
 * starts with that prefix.  Conversely every OpenAPI path must be served by
 * at least one mounted prefix.
 *
 * Infrastructure mounts (static files, Swagger UI, metrics endpoint) are
 * expected to be absent from the OpenAPI spec and are in IGNORE_MOUNTED.
 * OpenAPI paths that describe internal / deprecated surfaces not reached via
 * Express (e.g. the root / entry) are in IGNORE_OPENAPI.
 *
 * Keeping the contract green
 * --------------------------
 *   New route group → mount it in index.ts AND add paths to openapi.json.
 *   New OpenAPI path → ensure its prefix is mounted in index.ts.
 *   Infrastructure-only mount → add to IGNORE_MOUNTED with a reason.
 *   OpenAPI-only path → add to IGNORE_OPENAPI with a reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Ignore lists (every entry MUST carry a reason string) ─────────────────────

/**
 * Route prefixes mounted in index.ts that are intentionally absent from the
 * OpenAPI spec (infrastructure, static files, developer tools).
 */
const IGNORE_MOUNTED = new Map([
  ['/metrics',               'Prometheus scrape endpoint; not part of the public API contract'],
  ['/portal',                'Static developer portal HTML; not an API route'],
  ['/portal/governance',     'Static governance dashboard HTML; not an API route'],
  ['/docs/marketplace',      'Static marketplace HTML; not an API route'],
  ['/api/v1/docs',           'Swagger UI; describes the API but is not itself an API endpoint'],
  ['/api/feature-flags',     'Internal feature-flag read surface; not yet in the public OpenAPI spec'],
  ['/api/events',            'Internal event-store read surface; not yet in the public OpenAPI spec'],
  ['/api/graphql',           'GraphQL endpoint; served separately from the REST OpenAPI spec'],
  ['/graphql',               'GraphQL endpoint alias; served separately from the REST OpenAPI spec'],
  ['/api/v1/keys',           'Self-service key management; not yet in the public OpenAPI spec'],
  ['/api/v1/releases',       'Release notes endpoint; not yet in the public OpenAPI spec'],
  ['/api/v1/sandbox',        'Sandbox environment endpoint; not yet in the public OpenAPI spec'],
  ['/api/v1/governance',     'On-chain governance proposals; not yet in the public OpenAPI spec'],
  ['/api/v1/status',         'Operational status page; not yet in the public OpenAPI spec'],
  ['/api/v1/admin',          'Admin-only management surface; intentionally excluded from public spec'],
  ['/api/v1',                'Platform routes (plugins, lineage, self-healing, rate-limits, compliance); not yet in public spec'],
  ['/api/v2',                'v2 routes router — covered by /api/v2/* OpenAPI paths'],
  // Auth middleware mounts (not routers) — the actual routes are served by /api/v2 router below
  ['/api/v2/prices',         'authMiddleware mount only; actual routes served by the /api/v2 router'],
  ['/api/v2/history',        'authMiddleware mount only; actual routes served by the /api/v2 router'],
  ['/api/v2/health',         'optionalAuthMiddleware mount only; actual routes served by the /api/v2 router'],
  ['/api/v2/sources',        'optionalAuthMiddleware mount only; actual routes served by the /api/v2 router'],
]);

/**
 * OpenAPI path prefixes that do not correspond to a discrete router mount in
 * index.ts (e.g. paths served directly by a broadly-mounted router, or
 * documented legacy paths).
 */
const IGNORE_OPENAPI = new Map([
  ['/api/v1',           'Root v1 entry listed in OpenAPI for discovery; served by the v1 router mounted at /api/v1'],
  ['/api/v1/usage',     'Usage/analytics routes — mounted under the v1 router, not as a standalone prefix in index.ts'],
  ['/api/v1/webhooks',  'Webhooks are mounted as /api/v1/webhooks — covered by the mount check'],
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Extract app.use('/prefix', ...) route mounts from index.ts.
 * Returns a Set of prefix strings.
 */
function extractMountedPrefixes(src) {
  const prefixes = new Set();
  // Match: app.use('/api/v1/prices', authMiddleware, v1Routes)
  //   or:  app.use('/metrics', metricsHandler)
  //   or:  app.get('/metrics', metricsHandler)
  for (const m of src.matchAll(/app\.(?:use|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g)) {
    prefixes.add(m[1]);
  }
  return prefixes;
}

/**
 * Extract the set of path prefixes from the OpenAPI document.
 * We use the first two path segments as the "group" prefix (e.g.
 * /api/v1/prices/{asset} → /api/v1/prices, /metrics → /metrics).
 */
function extractOpenApiPrefixes(spec) {
  const prefixes = new Set();
  for (const fullPath of Object.keys(spec.paths || {})) {
    // Split and take up to the third segment for grouping:
    //   /api/v1/prices/{asset} → /api/v1/prices
    //   /metrics → /metrics
    const parts = fullPath.split('/').filter(Boolean);
    const group = '/' + parts.slice(0, Math.min(3, parts.length)).join('/');
    prefixes.add(group);
  }
  return prefixes;
}

// ── Load sources ──────────────────────────────────────────────────────────────

const indexSrc = read('api/src/index.ts');
const openApiSpec = JSON.parse(read('api/openapi.json'));

const mounted = extractMountedPrefixes(indexSrc);
const openApiGroups = extractOpenApiPrefixes(openApiSpec);

console.log(`Express mounts found in index.ts: ${mounted.size}`);
console.log(`OpenAPI path groups in openapi.json: ${openApiGroups.size}`);

// ── Check: every OpenAPI group has a matching mount ───────────────────────────

const undocumentedMounts = [...mounted]
  .filter(prefix => {
    if (IGNORE_MOUNTED.has(prefix)) return false;
    // A mount is "documented" if at least one OpenAPI path starts with it,
    // or if a more-specific OpenAPI group starts with this prefix.
    for (const group of openApiGroups) {
      if (group.startsWith(prefix) || prefix.startsWith(group)) return false;
    }
    return true;
  })
  .sort();

const unmountedOpenApi = [...openApiGroups]
  .filter(group => {
    if (IGNORE_OPENAPI.has(group)) return false;
    // An OpenAPI group is "mounted" if at least one Express mount is a prefix of it
    // (e.g. /api/v1 covers /api/v1/prices).
    for (const prefix of mounted) {
      if (group.startsWith(prefix) || prefix === group) return false;
    }
    return true;
  })
  .sort();

// ── Report ────────────────────────────────────────────────────────────────────

let failed = false;

if (undocumentedMounts.length > 0) {
  failed = true;
  console.error('\nFAIL  Express route mounts with no matching OpenAPI path:');
  console.error('      To fix: add the relevant paths to api/openapi.json, OR add the');
  console.error('      mount prefix to IGNORE_MOUNTED in scripts/check-route-contract.mjs');
  console.error('      with a reason.\n');
  for (const p of undocumentedMounts) console.error(`  MOUNT_UNDOCUMENTED  ${p}`);
}

if (unmountedOpenApi.length > 0) {
  failed = true;
  console.error('\nFAIL  OpenAPI paths with no matching Express route mount:');
  console.error('      To fix: mount the router at the matching prefix in api/src/index.ts,');
  console.error('      OR add the group to IGNORE_OPENAPI in scripts/check-route-contract.mjs');
  console.error('      with a reason.\n');
  for (const p of unmountedOpenApi) console.error(`  OPENAPI_UNMOUNTED   ${p}`);
}

if (failed) process.exit(1);

console.log('\nAll route contract checks passed.');
console.log(`  ${mounted.size} mounts, ${openApiGroups.size} OpenAPI groups,`,
            `${IGNORE_MOUNTED.size} mount ignores, ${IGNORE_OPENAPI.size} OpenAPI ignores.`);
