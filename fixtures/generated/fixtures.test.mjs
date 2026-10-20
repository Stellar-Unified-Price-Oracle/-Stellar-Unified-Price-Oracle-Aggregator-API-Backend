// Run with: node --test fixtures/generated/fixtures.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render, OUT, SCHEMAS } from '../../scripts/generate-schema-fixtures.mjs';

test('committed fixtures match generator output (deterministic)', () => {
  assert.equal(readFileSync(OUT, 'utf8'), render());
  assert.equal(render(), render());
});

test('every schema has valid and empty_object cases', () => {
  const { schemas } = JSON.parse(readFileSync(OUT, 'utf8'));
  for (const name of SCHEMAS) {
    assert.ok(schemas[name].valid, `${name}.valid`);
    assert.deepEqual(schemas[name].empty_object, {});
  }
});

test('price is a string integer (no float)', () => {
  const { schemas } = JSON.parse(readFileSync(OUT, 'utf8'));
  assert.match(schemas.AssetPrice.valid.price, /^\d+$/);
});
