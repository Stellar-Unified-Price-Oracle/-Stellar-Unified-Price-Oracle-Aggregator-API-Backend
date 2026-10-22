import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(root, 'scripts/publish-feed-source-coverage.mjs');
const source = JSON.parse(fs.readFileSync(path.join(root, 'scripts/feed-source-coverage.json'), 'utf8'));

function run(manifest) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-coverage-'));
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = spawnSync(process.execPath, [generator, '--manifest', manifestPath, '--check'], { encoding: 'utf8' });
  fs.rmSync(directory, { recursive: true, force: true });
  return result;
}

test('accepts complete current coverage manifest', () => {
  const result = run(source);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts quorum at eligible-provider boundary', () => {
  const manifest = structuredClone(source);
  manifest.feeds[0].quorum = { minSources: 4 };
  const result = run(manifest);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /quorum must be null/);
});

test('rejects missing production feed', () => {
  const manifest = structuredClone(source);
  manifest.feeds.pop();
  const result = run(manifest);
  assert.match(result.stderr, /feeds must contain exactly 5 rows/);
  assert.match(result.stderr, /missing production feed/);
});

test('rejects unsupported source and quorum above provider count', () => {
  const manifest = structuredClone(source);
  manifest.feeds[0].sources = ['unknown-provider'];
  manifest.feeds[0].quorum = { minSources: 2 };
  const result = run(manifest);
  assert.match(result.stderr, /unknown source/);
  assert.match(result.stderr, /quorum must be null or minSources/);
});

test('requires timestamp and evidence for measured runtime status', () => {
  const manifest = structuredClone(source);
  manifest.runtimeEvidence.status = 'measured';
  const result = run(manifest);
  assert.match(result.stderr, /measured runtime evidence requires measuredAt and evidence/);
});
