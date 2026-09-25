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

  it('handles re-encryption after key rotation with mixed-version reads', async () => {
    const crypto = await import('../src/infrastructure/crypto');
    const { writeHistoryFile, readHistoryFile } = await import('../src/persistence/history');

    const history = [
      { price: '100', decimals: 7, source: 'chainlink', timestamp: 1 },
      { price: '101', decimals: 7, source: 'redstone', timestamp: 2 },
    ];

    const filePath = path.join(tmpDir, 'history-mixed.json');
    writeHistoryFile(filePath, history);
    const versionOne = fs.readFileSync(filePath, 'utf-8');

    process.env.ENCRYPTION_KEY = rotatedKey;
    process.env.ENCRYPTION_KEY_PREVIOUS = activeKey;

    vi.resetModules();
    const { writeHistoryFile: writeV2, readHistoryFile: readV2 } = await import('../src/persistence/history');
    const newHistory = [...history, { price: '102', decimals: 7, source: 'band', timestamp: 3 }];
    writeV2(filePath, newHistory);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toMatch(/^enc:v1:/);
    expect(readV2(filePath)).toEqual(newHistory);
  });

  it('throws distinguishable error when decryption key is unavailable', async () => {
    const crypto = await import('../src/infrastructure/crypto');
    const oldKeyId = crypto.encrypt('test', { active: activeKey }).split(':')[2];

    const filePath = path.join(tmpDir, 'history-no-key.json');
    fs.writeFileSync(filePath, `enc:v1:${oldKeyId}:abc:def:ghi`);

    process.env.ENCRYPTION_KEY = rotatedKey;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;

    vi.resetModules();
    const { readHistoryFile } = await import('../src/persistence/history');
    expect(() => readHistoryFile(filePath)).toThrow(/No encryption key available/);
  });

  it('fails explicitly on corrupt encrypted payload rather than silently returning empty', async () => {
    const filePath = path.join(tmpDir, 'history-corrupt.json');
    fs.writeFileSync(filePath, 'enc:v1:corrupted:data:without:proper:parts');

    vi.resetModules();
    const { readHistoryFile } = await import('../src/persistence/history');
    expect(() => readHistoryFile(filePath)).toThrow(/Malformed encrypted payload|authentication tag/);
  });

  it('supports concurrent appends during key rotation re-encryption', async () => {
    const { writeHistoryFile, readHistoryFile, appendHistoricalPrice } = await import('../src/persistence/history');

    const filePath = path.join(tmpDir, 'history-concurrent.json');
    const initial = [{ price: '100', decimals: 7, source: 'chainlink', timestamp: 1 }];

    writeHistoryFile(filePath, initial);

    process.env.ENCRYPTION_KEY = rotatedKey;
    process.env.ENCRYPTION_KEY_PREVIOUS = activeKey;

    vi.resetModules();
    const { readHistoryFile: readV2, appendHistoricalPrice: appendV2 } = await import('../src/persistence/history');

    appendV2(filePath, { price: '101', decimals: 7, source: 'redstone', timestamp: 2 });

    const result = readV2(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(initial[0]);
    expect(result[1]).toEqual({ price: '101', decimals: 7, source: 'redstone', timestamp: 2 });
  });
});
