import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCompose,
  scanKubernetesFile,
  scanProductionPlaceholders,
} from '../check-no-dev-secrets.mjs';

test('flags the previously committed dev Vault token and dev-mode settings', () => {
  const content = [
    'environment:',
    '  VAULT_DEV_ROOT_TOKEN_ID: "dev-root-super-secret-token"',
    '  VAULT_DEV_LISTEN_ADDRESS: "0.0.0.0:8200"',
    'command: server -dev',
  ].join('\n');
  const labels = scanKubernetesFile(content).map((finding) => finding.label);
  assert.ok(labels.some((label) => /root token/.test(label)));
  assert.ok(labels.some((label) => /VAULT_DEV_ROOT_TOKEN_ID/.test(label)));
  assert.ok(labels.some((label) => /dev server mode/.test(label)));
});

test('accepts a production overlay that references a secret manager', () => {
  const content = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: vault-token',
    'stringData:',
    '  token: ${VAULT_TOKEN}',
  ].join('\n');
  assert.deepEqual(scanKubernetesFile(content), []);
  assert.deepEqual(scanProductionPlaceholders(content), []);
});

test('flags committed placeholder secrets in production overlays', () => {
  for (const value of ['CHANGE_ME', 'replace-with-a-token', 'example-secret', 'dev-root']) {
    const content = `stringData:\n  token: ${value}\n`;
    assert.ok(scanProductionPlaceholders(content).length > 0, value);
  }
});

test('compose must not contain literal tokens, host-wide 8200 binding, or dev Vault volumes', () => {
  const good = [
    'ports:',
    '  - "127.0.0.1:8200:8200"',
    'environment:',
    '  VAULT_DEV_ROOT_TOKEN_ID: "${VAULT_DEV_ROOT_TOKEN_ID:?generated}"',
    '  VAULT_TOKEN: "${VAULT_DEV_ROOT_TOKEN_ID:?generated}"',
  ].join('\n');
  assert.deepEqual(checkCompose(good), []);

  const bad = [
    'ports:',
    '  - "8200:8200"',
    'environment:',
    '  VAULT_DEV_ROOT_TOKEN_ID: "dev-root-super-secret-token"',
    '  VAULT_TOKEN: "dev-root-super-secret-token"',
    'volumes:',
    '  - vault_data:/vault/file',
  ].join('\n');
  const labels = checkCompose(bad).map((finding) => finding.label);
  assert.ok(labels.some((label) => /port 8200/.test(label)));
  assert.ok(labels.some((label) => /literal Vault dev token/.test(label)));
  assert.ok(labels.some((label) => /literal Vault token/.test(label)));
  assert.ok(labels.some((label) => /persistence volume/.test(label)));
});
