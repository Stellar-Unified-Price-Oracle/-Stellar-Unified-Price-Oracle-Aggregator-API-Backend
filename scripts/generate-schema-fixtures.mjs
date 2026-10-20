#!/usr/bin/env node
// Deterministic fixture generator: reads api/openapi.json and writes
// fixtures/generated/api-fixtures.json. Usage:
//   node scripts/generate-schema-fixtures.mjs          # write
//   node scripts/generate-schema-fixtures.mjs --check  # exit 1 if stale
// Rules: value = FIELD_OVERRIDES[prop] ?? schema.example ?? type default;
// nullable properties without an example become null. No randomness, no clock.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(root, 'api/openapi.json');
export const OUT = path.join(root, 'fixtures/generated/api-fixtures.json');
export const SCHEMAS = ['AssetPrice', 'HistoryEntry', 'HistoryData', 'PaginationMeta', 'CursorPaginationMeta', 'ErrorResponse'];
const SKIP_PROPS = new Set(['_links']);
const FIELD_OVERRIDES = {
  asset: 'XLM', price: '10000000000', decimals: 7, source: 'chainlink', timestamp: 1719000000,
  page: 1, limit: 100, total: 1, totalPages: 1, code: 'NOT_FOUND', message: 'Asset not found',
};

function build(spec, schema, prop) {
  if (schema.$ref) return build(spec, resolve(spec, schema.$ref), prop);
  if (prop in FIELD_OVERRIDES) return FIELD_OVERRIDES[prop];
  if (schema.example !== undefined) return schema.example;
  if (schema.nullable) return null;
  switch (schema.type) {
    case 'object': return buildObject(spec, schema);
    case 'array': return [build(spec, schema.items, prop)];
    case 'boolean': return false;
    case 'integer': case 'number': return 0;
    default: return 'sample';
  }
}

function buildObject(spec, schema) {
  const out = {};
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    if (!SKIP_PROPS.has(k)) out[k] = build(spec, v, k);
  }
  return out;
}

function resolve(spec, ref) {
  return ref.replace('#/', '').split('/').reduce((n, k) => n[k], spec);
}

export function generate(spec = JSON.parse(readFileSync(SPEC, 'utf8'))) {
  const schemas = {};
  for (const name of SCHEMAS) {
    const schema = spec.components.schemas[name];
    const valid = buildObject(spec, schema);
    const cases = { valid, empty_object: {} };
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      if (v.type === 'array') cases[`empty_${k}`] = { ...valid, [k]: [] };
    }
    schemas[name] = cases;
  }
  return { generatedFrom: 'api/openapi.json', openapiVersion: spec.info.version, schemas };
}

export function render() {
  return JSON.stringify(generate(), null, 2) + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = render();
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    if (cur !== next) { console.error('fixtures are stale: run node scripts/generate-schema-fixtures.mjs'); process.exit(1); }
  } else {
    writeFileSync(OUT, next);
    console.log(`wrote ${path.relative(root, OUT)}`);
  }
}
