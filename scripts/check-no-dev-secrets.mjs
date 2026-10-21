#!/usr/bin/env node
/**
 * Fails if development Vault settings, placeholder credentials, or committed
 * example secrets appear in Kubernetes overlays that reach staging/production,
 * or if docker-compose.yml exposes a literal dev token / non-loopback Vault.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FORBIDDEN_DEV_PATTERNS = [
  { pattern: /dev-root-super-secret-token/g, label: 'known dev Vault root token' },
  { pattern: /VAULT_DEV_ROOT_TOKEN_ID/g, label: 'VAULT_DEV_ROOT_TOKEN_ID (dev-mode Vault)' },
  { pattern: /\bserver\s+-dev\b/g, label: 'Vault dev server mode' },
  { pattern: /\bvault\s+server\s+-dev\b/g, label: 'Vault dev server mode' },
  { pattern: /VAULT_DEV_LISTEN_ADDRESS/g, label: 'Vault dev listen address' },
];

export const FORBIDDEN_PLACEHOLDER_PATTERNS = [
  { pattern: /\bCHANGE_ME\b/g, label: 'CHANGE_ME placeholder secret' },
  { pattern: /\breplace-with-[a-z0-9-]+\b/g, label: 'replace-with-* placeholder secret' },
  { pattern: /\bexample-(?:token|secret|password)\b/g, label: 'example-* placeholder secret' },
  { pattern: /\bdev-root\b/g, label: 'dev-root placeholder token' },
];

function scan(content, patterns) {
  const findings = [];
  for (const { pattern, label } of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      findings.push({ line, label, match: match[0] });
    }
  }
  return findings;
}

export function scanKubernetesFile(content) {
  return scan(content, FORBIDDEN_DEV_PATTERNS);
}

export function scanProductionPlaceholders(content) {
  return scan(content, FORBIDDEN_PLACEHOLDER_PATTERNS);
}

export function checkCompose(content) {
  const findings = [];
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (/VAULT_DEV_ROOT_TOKEN_ID:\s*["']?[A-Za-z0-9]/.test(line) && !line.includes('${')) {
      findings.push({ line: index + 1, label: 'compose contains a literal Vault dev token' });
    }
    if (/VAULT_TOKEN:\s*["']?[A-Za-z0-9]/.test(line) && !line.includes('${')) {
      findings.push({ line: index + 1, label: 'compose contains a literal Vault token' });
    }
    if (/^\s*-\s*"?8200:8200"?\s*$/.test(line)) {
      findings.push({ line: index + 1, label: 'Vault port 8200 is bound beyond loopback' });
    }
    if (/^\s*-\s*vault_data(?::|\/)/.test(line)) {
      findings.push({ line: index + 1, label: 'Vault dev server declares a persistence volume' });
    }
  });
  return findings;
}

async function yamlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await yamlFiles(full)));
    else if (/\.ya?ml$/.test(entry.name)) files.push(full);
  }
  return files;
}

export async function checkRepository(root = ROOT) {
  const findings = [];
  const k8s = path.join(root, 'k8s');
  for (const file of await yamlFiles(k8s)) {
    const relative = path.relative(root, file);
    const content = await readFile(file, 'utf8');
    for (const finding of scanKubernetesFile(content)) {
      findings.push({ file: relative, ...finding });
    }
    if (/overlays\/(prod|staging)/.test(relative) && !relative.endsWith('.example.yaml')) {
      for (const finding of scanProductionPlaceholders(content)) {
        findings.push({ file: relative, ...finding });
      }
    }
  }

  const compose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8').catch(() => '');
  for (const finding of checkCompose(compose)) {
    findings.push({ file: 'docker-compose.yml', ...finding });
  }
  return findings;
}

async function main() {
  const findings = await checkRepository();
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.label}${finding.match ? ` (${finding.match})` : ''}`);
    }
    console.error(`\n${findings.length} development/placeholder secret finding(s); see docs/SECRET_STORAGE.md`);
    return 1;
  }
  console.log('no development Vault settings or placeholder secrets in staging/production configuration');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
