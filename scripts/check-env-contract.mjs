#!/usr/bin/env node
/**
 * scripts/check-env-contract.mjs  — issue #620
 *
 * Reconciles the set of environment variables that the two Node services
 * actually read against the variables documented in .env.example, and
 * reports any gap in either direction.
 *
 * Exit 0 — every read var is documented and every documented var is read
 *           (or explicitly ignored with a reason below).
 * Exit 1 — undocumented read vars or documented-but-unread vars exist.
 *
 * To add a new variable
 * ---------------------
 *   1. Document it in .env.example with a value and a comment.
 *   2. Read it in the relevant service config/source file.
 *   If either side is legitimately absent, add it to IGNORE_READ_ONLY or
 *   IGNORE_DOC_ONLY below with a mandatory reason string.
 *
 * Changing the ignore lists to silence failures without fixing the real
 * drift is a breaking change to the configuration contract.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Ignore lists (each entry MUST carry a reason string) ──────────────────────

/**
 * Variables read by code but intentionally absent from .env.example.
 * Typical cases: runtime/cloud platform variables, test-only injections,
 * internal feature flags not exposed to operators.
 */
const IGNORE_READ_ONLY = new Map([
  ['NODE_ENV',              'standard Node.js runtime variable; not an operator .env knob'],
  ['AWS_REGION',            'cloud-provider metadata variable; documented in docs/PRODUCTION_DEPLOYMENT.md'],
  ['VITEST',                'injected by the vitest test runner; not an operator variable'],
  ['HISTORY_DIR',           'integration-test orchestrator (scripts/integration-test.mjs); not a production setting'],
  ['SANDBOX_RESET_TOKEN',   'sandbox route internal; operator exposure is planned future work'],
  ['BACKUP_ENCRYPTION_KEY', 'alias read in config.ts; documented form is BACKUP_ENCRYPTION_KEY_HEX (same value)'],
  ['API_KEYS',              'seed format for the key store; documented in docs/API_KEY_STORE.md, not .env.example (format differs per operator)'],
  ['ADMIN_API_KEY',         'bootstrap admin key; seeded by deployment automation, not a stable .env knob'],
  ['ADMIN_KEY_PREFIX',      'bootstrap key prefix; companion to ADMIN_API_KEY'],
]);

/**
 * Variables documented in .env.example that are read via a dynamic pattern
 * the static regex cannot detect, or read in a file outside the scanned src
 * directories.  Each entry MUST explain where the variable is actually consumed.
 */
const IGNORE_DOC_ONLY = new Map([
  // Consumed by the PostgreSQL Docker image entrypoint, not by our config.ts.
  ['POSTGRES_USER',              'Docker image entrypoint; not read by service source code'],
  ['POSTGRES_PASSWORD',          'Docker image entrypoint; not read by service source code'],
  ['POSTGRES_DB',                'Docker image entrypoint; not read by service source code'],

  // Read via dynamic template literal in services/aggregator/src/infrastructure/cost-model.ts:
  //   process.env[`ORACLE_BUDGET_DAILY_CALLS_${source.toUpperCase()}`]
  // Static regex cannot capture parameterised env reads.
  ['ORACLE_BUDGET_DAILY_CALLS_CHAINLINK',  'dynamic read: process.env[`ORACLE_BUDGET_DAILY_CALLS_${source}`] in cost-model.ts'],
  ['ORACLE_BUDGET_DAILY_CALLS_REDSTONE',   'dynamic read: process.env[`ORACLE_BUDGET_DAILY_CALLS_${source}`] in cost-model.ts'],
  ['ORACLE_BUDGET_DAILY_CALLS_BAND',       'dynamic read: process.env[`ORACLE_BUDGET_DAILY_CALLS_${source}`] in cost-model.ts'],
  ['ORACLE_BUDGET_DAILY_CALLS_REFLECTOR',  'dynamic read: process.env[`ORACLE_BUDGET_DAILY_CALLS_${source}`] in cost-model.ts'],

  // Read via decryptSecret wrapper in api/src/governance/audit-logger.ts:
  //   loadAuditSecrets(env) receives process.env as parameter, then reads env.AUDIT_SECRET
  // The parameter-destructuring pattern is not captured by the process.env.X regex.
  ['AUDIT_SECRET',                'parameter-env read: loadAuditSecrets(process.env).AUDIT_SECRET in audit-logger.ts'],
  ['AUDIT_SECRET_PREVIOUS',       'parameter-env read: loadAuditSecrets(process.env).AUDIT_SECRET_PREVIOUS in audit-logger.ts'],

  // Read in the audit-retention scheduler (api/src/governance/audit-logger.ts exports
  // startAuditRetentionScheduler which reads these at schedule-init time).
  ['AUDIT_LOG_DIR',               'read at scheduler init in audit-logger.ts via process.env.AUDIT_LOG_DIR indirection'],
  ['AUDIT_RETENTION_DAYS',        'read at scheduler init in audit-logger.ts'],
  ['AUDIT_RETENTION_SWEEP_MS',    'read at scheduler init in audit-logger.ts'],

  // Read via secretEnv() wrapper which calls decryptSecret(process.env[name]) —
  // the name is passed as a string literal so static regex misses it.
  ['WS_CSRF_SECRET',              'read via secretEnv("WS_CSRF_SECRET") in api/src/infrastructure/config.ts'],
  ['WS_HMAC_SECRET',              'read via secretEnv("WS_HMAC_SECRET") in api/src/infrastructure/config.ts'],

  // Read in api/src/webhooks/ssrf.ts and api/src/webhooks/webhook-store.ts
  // via process.env[name] dynamic patterns or helper wrappers.
  ['WEBHOOK_ALLOWED_HOSTS',           'read in api/src/webhooks/ssrf.ts (SSRF allowlist enforcement)'],
  ['WEBHOOK_ALLOWED_HOSTS_BY_TENANT', 'read in api/src/infrastructure/config.ts hostMapEnv() helper'],
  ['WEBHOOK_ALLOW_PRIVATE_IPS',       'read in api/src/webhooks/ssrf.ts (SSRF policy guard)'],
  ['WEBHOOK_REQUIRE_HTTPS',           'read in api/src/webhooks/ssrf.ts (scheme enforcement)'],
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walkSrc(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(rel, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

function extractDocumentedVars(src) {
  const vars = new Set();
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) vars.add(key);
  }
  return vars;
}

function extractProcessEnvReads(src) {
  const vars = new Set();
  // process.env.FOO_BAR  or  process.env['FOO_BAR']  or  process.env["FOO_BAR"]
  for (const m of src.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g)) {
    vars.add(m[1] ?? m[2]);
  }
  // secretEnv('FOO_BAR') / secretEnv("FOO_BAR")  — decryptSecret(process.env[name]) wrapper
  for (const m of src.matchAll(/secretEnv\(['"]([A-Z][A-Z0-9_]+)['"]\)/g)) {
    vars.add(m[1]);
  }
  // optionalSecretEnv('FOO_BAR')
  for (const m of src.matchAll(/optionalSecretEnv\(['"]([A-Z][A-Z0-9_]+)['"]\)/g)) {
    vars.add(m[1]);
  }
  return vars;
}

/**
 * Extract every key declared in the aggregator's Zod envShape object.
 * These are the variables the aggregator config-schema validates; they may
 * not appear as bare process.env reads (the schema itself calls parseConfigEnv
 * with the whole process.env object).
 */
function extractSchemaKeys(schemaSrc) {
  const vars = new Set();
  // Match 4-space-indented top-level keys in the envShape literal:
  //   PORT: intVar(...)
  //   WATCHED_ASSETS: assetsSchema
  for (const m of schemaSrc.matchAll(/^ {4}([A-Z][A-Z0-9_]+):\s*(?:intVar|floatVar|boolVar|urlVar|commaListSchema|assetsSchema|z\.)/gm)) {
    vars.add(m[1]);
  }
  return vars;
}

// ── 1. Documented vars ────────────────────────────────────────────────────────

const documented = extractDocumentedVars(read('.env.example'));
console.log(`Documented vars in .env.example: ${documented.size}`);

// ── 2. Read vars — scan all non-test source files in both services ─────────────

const srcFiles = [
  ...walkSrc('api/src'),
  ...walkSrc('services/aggregator/src'),
];

const readVars = new Set();
for (const rel of srcFiles) {
  for (const v of extractProcessEnvReads(read(rel))) readVars.add(v);
}

// Add keys from the aggregator's Zod schema (validated via parseConfigEnv).
const aggSchemaSrc = read('services/aggregator/src/infrastructure/config-schema.ts');
for (const v of extractSchemaKeys(aggSchemaSrc)) readVars.add(v);

console.log(`Vars read by services (${srcFiles.length} source files + schema): ${readVars.size}`);

// ── 3. Diff ───────────────────────────────────────────────────────────────────

const readButUndocumented = [...readVars]
  .filter(v => !documented.has(v) && !IGNORE_READ_ONLY.has(v))
  .sort();

const documentedButUnread = [...documented]
  .filter(v => !readVars.has(v) && !IGNORE_DOC_ONLY.has(v))
  .sort();

// ── 4. Report ─────────────────────────────────────────────────────────────────

let failed = false;

if (readButUndocumented.length > 0) {
  failed = true;
  console.error('\nFAIL  Variables read by code but missing from .env.example:');
  console.error('      To fix: document them in .env.example with a comment and default value.');
  console.error('      If the variable is legitimately undocumentable, add it to');
  console.error('      IGNORE_READ_ONLY in scripts/check-env-contract.mjs with a reason.\n');
  for (const v of readButUndocumented) console.error(`  MISSING_DOC  ${v}`);
}

if (documentedButUnread.length > 0) {
  failed = true;
  console.error('\nFAIL  Variables in .env.example not read by any service source file:');
  console.error('      To fix: read them in a config file, or remove them from .env.example.');
  console.error('      If the variable is read via a dynamic/wrapper pattern the scanner');
  console.error('      cannot detect, add it to IGNORE_DOC_ONLY in');
  console.error('      scripts/check-env-contract.mjs with a reason.\n');
  for (const v of documentedButUnread) console.error(`  UNUSED_DOC   ${v}`);
}

if (failed) process.exit(1);

console.log('\nAll env-var contract checks passed.');
console.log(`  ${readVars.size} vars read, ${documented.size} documented,`,
            `${IGNORE_READ_ONLY.size} read-only ignores, ${IGNORE_DOC_ONLY.size} doc-only ignores.`);
