#!/usr/bin/env node
// Usage: oracle-conformance --base-url https://host [--asset XLM] [--spec path/to/openapi.json]
// Exit 0 = conformant, 1 = failures, 2 = usage/network error.
import { readFileSync } from 'node:fs';
import { KIT_VERSION, checkResponseSchema, checkPriceEncoding, checkCursorPagination, checkErrorResponse } from './checks.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
if (!args['base-url']) { console.error('missing --base-url'); process.exit(2); }
const base = args['base-url'].replace(/\/$/, '');
const asset = args.asset ?? 'XLM';
const spec = JSON.parse(readFileSync(args.spec ?? new URL('../../../api/openapi.json', import.meta.url), 'utf8'));
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };

const results = [];
const record = (name, errs) => { results.push({ name, errs }); console.log(`${errs.length ? 'FAIL' : 'PASS'} ${name}${errs.length ? '\n  ' + errs.join('\n  ') : ''}`); };

try {
  console.log(`oracle-conformance kit ${KIT_VERSION} against ${base}`);
  const price = await get(`/api/v1/prices/${asset}`);
  record('price schema', price.status === 200 ? checkResponseSchema(spec, 'AssetPrice', price.body) : [`status ${price.status}`]);
  record('price encoding', price.body ? checkPriceEncoding(price.body) : ['no body']);
  const pages = []; let cursor = null;
  for (let i = 0; i < 20; i++) {
    const h = await get(`/api/v1/history/${asset}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (h.status !== 200) { record('history fetch', [`status ${h.status}`]); break; }
    record(`history page ${i} schema`, checkResponseSchema(spec, 'HistoryData', h.body));
    pages.push(h.body); cursor = h.body.pagination?.nextCursor;
    if (!cursor) break;
  }
  record('cursor pagination', pages.length ? checkCursorPagination(pages, 2) : ['no pages']);
  const missing = await get('/api/v1/prices/__NO_SUCH_ASSET__');
  record('error contract (unknown asset)', checkErrorResponse(spec, missing.status, missing.body));
} catch (e) { console.error(`network error: ${e.message}`); process.exit(2); }
process.exit(results.some((r) => r.errs.length) ? 1 : 0);
