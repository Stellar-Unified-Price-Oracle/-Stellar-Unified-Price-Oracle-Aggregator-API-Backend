import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = join(repoRoot, 'scripts/rollback.sh');

function runDrill(extraEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'rollback-drill-'));
  const env = { ...process.env, HOME: cwd, ROLLBACK_DRY_RUN: 'true', REPO: 'org/repo', ...extraEnv };
  delete env.KUBECONFIG;
  const res = spawnSync('bash', [script, 'staging', 'abcdef1234'], { cwd, env, encoding: 'utf8' });
  let events = '';
  try {
    events = readFileSync(join(cwd, 'logs/rollback-events.log'), 'utf8');
  } catch {}
  rmSync(cwd, { recursive: true, force: true });
  return { ...res, events };
}

test('dry-run drill completes without a kubeconfig on the runner', () => {
  const { status, stdout, stderr, events } = runDrill();
  assert.equal(status, 0, stdout + stderr);
  assert.match(events, /ROLLBACK_COMPLETE env=staging sha=abcdef1234 ttr_seconds=\d+/);
});

test('a real rollback still requires a kubeconfig', () => {
  const { status, stdout, stderr } = runDrill({ ROLLBACK_DRY_RUN: 'false' });
  assert.notEqual(status, 0);
  assert.match(stdout + stderr, /KUBECONFIG is not set/);
});

const workflow = readFileSync(join(repoRoot, '.github/workflows/rollback.yml'), 'utf8');

test('drill step fails when rollback.sh fails instead of being masked by tee', () => {
  assert.match(workflow, /code=\$\{PIPESTATUS\[0\]\}/);
  assert.match(workflow, /exit "\$code"/);
});

test('drill TTR comes from the ROLLBACK_COMPLETE event, not step wall time', () => {
  assert.match(workflow, /ROLLBACK_COMPLETE .*ttr_seconds=/);
  assert.doesNotMatch(workflow, /steps\.start\.outputs\.ts/);
});
