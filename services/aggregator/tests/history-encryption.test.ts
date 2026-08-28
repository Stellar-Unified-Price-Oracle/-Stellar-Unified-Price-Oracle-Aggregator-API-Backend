import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const activeKey = 'a'.repeat(64);
const rotatedKey = 'b'.repeat(64);
let tmpDir = '';

describe('history encryption at rest', () => {
  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-history-'));
    process.env.ENCRYPT_HISTORY = 'true';
    process.env.ENCRYPTION_KEY = activeKey;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ENCRYPT_HISTORY;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  });

  it('encrypts history write paths and decrypts reads transparently', async () => {
    const { writeHistoryFile, readHistoryFile } = await import('../src/persistence/history');
    const filePath = path.join(tmpDir, 'history-xlm.json');
    const history = [{ price: '100', decimals: 7, source: 'chainlink', timestamp: 1 }];

    writeHistoryFile(filePath, history);

    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).toMatch(/^enc:v1:/);
    expect(raw).not.toContain('chainlink');
    expect(readHistoryFile(filePath)).toEqual(history);
  });

  it('decrypts historical files encrypted before key rotation', async () => {
    const crypto = await import('../src/infrastructure/crypto');
    const payload = crypto.encrypt(JSON.stringify([{ price: '101', decimals: 7, source: 'redstone', timestamp: 2 }]), {
      active: activeKey,
    });
    const filePath = path.join(tmpDir, 'history-xlm.json');
    fs.writeFileSync(filePath, payload);

    process.env.ENCRYPTION_KEY = rotatedKey;
    process.env.ENCRYPTION_KEY_PREVIOUS = activeKey;

    const { readHistoryFile } = await import('../src/persistence/history');
    expect(readHistoryFile(filePath)).toEqual([
      { price: '101', decimals: 7, source: 'redstone', timestamp: 2 },
    ]);
  });
});
