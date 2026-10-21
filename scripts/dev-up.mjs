#!/usr/bin/env node
/**
 * Generate a per-run Vault dev token, write it to the untracked `.env.vault`,
 * and start the local compose stack. No dev credential is committed.
 */
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const ENV_FILE = '.env';
const VAULT_ENV_FILE = '.env.vault';
const TOKEN_KEY = 'VAULT_DEV_ROOT_TOKEN_ID';

async function existingToken() {
  if (!existsSync(VAULT_ENV_FILE)) return null;
  const body = await readFile(VAULT_ENV_FILE, 'utf8');
  const line = body.split('\n').find((entry) => entry.startsWith(`${TOKEN_KEY}=`));
  return line ? line.slice(TOKEN_KEY.length + 1).trim() : null;
}

async function main() {
  if (!existsSync(ENV_FILE)) {
    console.error(`missing ${ENV_FILE}; copy it first: cp .env.example .env`);
    process.exitCode = 1;
    return;
  }
  const token = process.env[TOKEN_KEY] || (await existingToken()) || randomBytes(32).toString('hex');
  await writeFile(VAULT_ENV_FILE, `${TOKEN_KEY}=${token}\n`, { mode: 0o600 });
  await chmod(VAULT_ENV_FILE, 0o600);

  console.log(`Vault dev token (${VAULT_ENV_FILE}, chmod 600): ${token}`);
  console.log('This token is local-only, unsealed, in-memory, and must never hold real secrets.');

  const compose = spawn(
    'docker',
    ['compose', '--env-file', ENV_FILE, '--env-file', VAULT_ENV_FILE, 'up', '-d', ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  compose.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
