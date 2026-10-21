import { it, expect } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';
import { once } from 'events';
import { rotateSandboxLease } from '../src/oracle-sources/sandbox-credentials';

it('authenticates sandbox transport, revokes replaced keys, and rejects expired or unavailable leases', async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const directory = mkdtempSync(join(tmpdir(), 'provider-stub-'));
  const file = join(directory, 'lease.json');
  const origin = `http://127.0.0.1:${port}`;
  const first = rotateSandboxLease(file, origin);
  const child = spawn(process.execPath, [resolve(__dirname, '../../../scripts/stub-oracle-server.mjs')], {
    env: { ...process.env, STUB_ORACLE_PORT: String(port), SANDBOX_PROVIDER_LEASE_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Stub startup timed out')), 5000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Stub exited before ready')); });
      child.stdout.on('data', data => { if (String(data).includes('listening')) { clearTimeout(timeout); resolve(); } });
    });
    const request = (token: string) => fetch(`${origin}/price?fsym=XLM&tsym=USD&api_key=${token}`);
    expect((await request('production-secret')).status).toBe(401);
    expect((await request(first.token)).status).toBe(200);
    const next = rotateSandboxLease(file, origin);
    expect((await request(first.token)).status).toBe(401);
    expect((await request(next.token)).status).toBe(200);
    rotateSandboxLease(file, origin, 1000, Date.now() - 2000);
    expect((await request(next.token)).status).toBe(401);
    writeFileSync(file, '{');
    expect((await request(next.token)).status).toBe(401);
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(directory, { recursive: true, force: true });
  }
});

it('automatically renews sandbox credentials before expiry without exposing tokens', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'provider-renewal-'));
  const file = join(directory, 'lease.json');
  const child = spawn(process.execPath, [resolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs'), resolve(__dirname, '../../../scripts/rotate-sandbox-provider-credentials.ts'), file, 'http://127.0.0.1:4010', '1000', '--watch'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const output = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Automatic rotation timed out')), 5000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Renewal exited early: ${code}`)); });
      child.stdout.on('data', data => {
        output += String(data);
        if (output.split('\n').filter(line => line.includes('"rotated":true')).length >= 2) { clearTimeout(timeout); resolve(output); }
      });
    });
    expect(output).not.toContain('sbx_');
    const reports = output.trim().split('\n').map(line => JSON.parse(line));
    expect(reports[reports.length - 1].expiresAt).toBeGreaterThan(reports[0].expiresAt);
    expect(reports.some(report => report.rotated === false)).toBe(true);
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(directory, { recursive: true, force: true });
  }
});
