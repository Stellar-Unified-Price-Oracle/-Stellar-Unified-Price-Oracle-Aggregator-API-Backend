import fs from 'fs';
import path from 'path';
import { config } from '../infrastructure/config';
import { encrypt, decrypt, isEncrypted, isEncryptionConfigured } from '../infrastructure/crypto';

const DATA_DIR = path.resolve(__dirname, '../../data');
const HISTORY_FILE = (asset: string) => path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Whether historical price files should be encrypted at rest (issue #41). */
function historyEncryptionEnabled(): boolean {
  return config.security.encryption.encryptHistory && isEncryptionConfigured();
}

function readHistoryFile(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw) return [];
  const contents = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(contents);
}

function writeHistoryFile(filePath: string, history: any[]): void {
  const serialized = JSON.stringify(history);
  const payload = historyEncryptionEnabled() ? encrypt(serialized) : serialized;
  fs.writeFileSync(filePath, payload);
}

export function appendHistoricalPrice(
  asset: string,
  price: string,
  decimals: number,
  source: string,
  timestamp: number,
): void {
  ensureDataDir();
  const filePath = HISTORY_FILE(asset);
  let history: any[] = [];
  try {
    history = readHistoryFile(filePath);
  } catch { /* ignore corrupt data */ }
  history.push({ price, decimals, source, timestamp });
  writeHistoryFile(filePath, history);
}

export function getHistoricalPrices(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): any[] {
  const filePath = HISTORY_FILE(asset);
  try {
    let history = readHistoryFile(filePath);
    if (from) history = history.filter((h: any) => h.timestamp >= from);
    if (to) history = history.filter((h: any) => h.timestamp <= to);
    return history.slice(-limit);
  } catch {
    return [];
  }
}
