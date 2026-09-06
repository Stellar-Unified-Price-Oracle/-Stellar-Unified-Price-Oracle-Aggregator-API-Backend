import fs from 'fs';
import path from 'path';
import { config } from '../infrastructure/config';
import { encrypt, decrypt, isEncrypted, isEncryptionConfigured } from '../infrastructure/crypto';

export interface HistoricalPriceEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

export const DATA_DIR = path.resolve(__dirname, '../../data');
export const HISTORY_FILE = (asset: string) => path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Whether historical price files should be encrypted at rest (issue #41). */
export function historyEncryptionEnabled(): boolean {
  return config.security.encryption.encryptHistory && isEncryptionConfigured();
}

export function readHistoryFile(filePath: string): HistoricalPriceEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw) return [];
  const contents = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(contents) as HistoricalPriceEntry[];
}

export function writeHistoryFile(filePath: string, history: HistoricalPriceEntry[]): void {
  const serialized = JSON.stringify(history);
  const payload = historyEncryptionEnabled() ? encrypt(serialized) : serialized;
  fs.writeFileSync(filePath, payload);
}

/**
 * Drop entries older than the retention window, then keep only the newest
 * maxEntries (issue #214). Entry timestamps are Unix seconds.
 */
function pruneHistory(history: HistoricalPriceEntry[]): HistoricalPriceEntry[] {
  const { maxEntries, retentionSeconds } = config.history;
  let pruned = history;

  if (retentionSeconds > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;
    pruned = pruned.filter((h) => h.timestamp >= cutoff);
  }

  return maxEntries > 0 && pruned.length > maxEntries ? pruned.slice(-maxEntries) : pruned;
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
  let history: HistoricalPriceEntry[] = [];
  try {
    history = readHistoryFile(filePath);
  } catch { /* ignore corrupt data */ }
  history.push({ price, decimals, source, timestamp });
  writeHistoryFile(filePath, pruneHistory(history));
}

export function getHistoricalPrices(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): HistoricalPriceEntry[] {
  const filePath = HISTORY_FILE(asset);
  try {
    let history = readHistoryFile(filePath);
    if (from) history = history.filter((h) => h.timestamp >= from);
    if (to) history = history.filter((h) => h.timestamp <= to);
    return history.slice(-limit);
  } catch {
    return [];
  }
}
