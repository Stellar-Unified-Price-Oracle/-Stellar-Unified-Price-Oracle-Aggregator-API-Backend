import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInventory, parseInventory } from '../check-workflow-inventory.mjs';

const markdown = `# CI

## Inventory

| Workflow file | Classification | Owner | Authority / purpose | Triggers |
|---|---|---|---|---|
| \`ci.yml\` | Blocking gate | CI | Main gate | PR |
| \`drill.yml\` | Scheduled drill | SRE | Rehearsal | weekly |

## Next
`;

const contents = {
  'ci.yml': 'name: CI\nconcurrency:\n  group: ci\n  cancel-in-progress: true\non:\n  pull_request:\n',
  'drill.yml': 'name: Drill\nconcurrency:\n  group: drill\n  cancel-in-progress: false\non:\n  schedule:\n  # drill-outcome\n',
};

test('parses inventory rows', () => {
  const rows = parseInventory(markdown);
  assert.deepEqual(rows.map((row) => row.file), ['ci.yml', 'drill.yml']);
  assert.equal(rows[0].classification, 'Blocking gate');
});

test('accepts a complete inventory', () => {
  const result = checkInventory({ markdown, files: ['ci.yml', 'drill.yml'], contents });
  assert.deepEqual(result.errors, []);
});

test('rejects an unlisted workflow', () => {
  const result = checkInventory({ markdown, files: ['ci.yml', 'drill.yml', 'new.yml'], contents: { ...contents, 'new.yml': 'name: New\nconcurrency: x\n' } });
  assert.ok(result.errors.some((error) => /new\.yml: not listed/.test(error)));
});

test('rejects duplicates, invalid classifications, and missing concurrency', () => {
  const duplicate = markdown.replace('## Next', '| `ci.yml` | Blocking gate | CI | dup | PR |\n\n## Next');
  assert.ok(checkInventory({ markdown: duplicate, files: ['ci.yml', 'drill.yml'], contents }).errors.some((error) => /more than once/.test(error)));

  const invalid = markdown.replace('Blocking gate', 'Sometimes');
  assert.ok(checkInventory({ markdown: invalid, files: ['ci.yml', 'drill.yml'], contents }).errors.some((error) => /invalid classification/.test(error)));

  const noConcurrency = { ...contents, 'ci.yml': 'name: CI\non:\n  pull_request:\n' };
  assert.ok(checkInventory({ markdown, files: ['ci.yml', 'drill.yml'], contents: noConcurrency }).errors.some((error) => /missing top-level concurrency/.test(error)));
});

test('scheduled drills must route outcomes to an issue', () => {
  const noRouting = { ...contents, 'drill.yml': contents['drill.yml'].replace('# drill-outcome', '') };
  assert.ok(checkInventory({ markdown, files: ['ci.yml', 'drill.yml'], contents: noRouting }).errors.some((error) => /drill-outcome/.test(error)));
});
