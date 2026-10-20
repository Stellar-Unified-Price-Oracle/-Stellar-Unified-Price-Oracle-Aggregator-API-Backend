import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url).pathname;

test('generated bindings are reproducible (no drift from schema)', () => {
  execFileSync('node', ['scripts/generate-feed-metadata-bindings.mjs', '--check'], { cwd: root });
});

test('schema keeps backward-compatible required fields', () => {
  const s = JSON.parse(readFileSync(`${root}packages/sdk-bindings/schema/feed-metadata.schema.json`, 'utf8'));
  for (const k of ['asset', 'decimals', 'sources', 'heartbeatSeconds', 'status']) {
    assert.ok(s.required.includes(k), `required field removed: ${k}`);
  }
});
