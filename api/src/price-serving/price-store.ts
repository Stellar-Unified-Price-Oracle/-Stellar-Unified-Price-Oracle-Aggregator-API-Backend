import fs from 'fs';
import path from 'path';
import type { ApiPrice, HistoricalPriceEntry } from '@stellar-oracle/types';
import { DatabaseClient, type PriceHistory } from '../infrastructure/database';
import { decrypt, encrypt, isEncrypted, isEncryptionConfigured } from '../governance/crypto';
import { decodeCursor } from './pagination';

const DATA_DIR = path.resolve(__dirname, '../../data');
const HISTORY_FILE = (asset: string) => path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);
let db: DatabaseClient | null = null;

export const SANDBOX_ASSETS = ['XLM', 'USDC', 'BTC', 'ETH', 'USDT'] as const;

/** Replace file-backed data with deterministic, recent fixtures for sandbox resets. */
export function resetSandboxData(now = Math.floor(Date.now() / 1000)): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prices: Record<string, string> = {
    XLM: '0.1200000', USDC: '1.0000000', BTC: '68000.0000000',
    ETH: '3500.0000000', USDT: '1.0000000',
  };
  for (const asset of SANDBOX_ASSETS) {
    const history: HistoricalPriceEntry[] = Array.from({ length: 10 }, (_, index) => ({
      price: prices[asset], decimals: 7, source: 'sandbox-fixture', timestamp: now - (9 - index) * 60,
    }));
    const serialized = JSON.stringify(history, null, 2);
    fs.writeFileSync(HISTORY_FILE(asset), isEncryptionConfigured() ? encrypt(serialized) : serialized);
  }
}

/** Read and parse a history file, transparently decrypting if encrypted at rest. */
function readHistoryFile(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw) return [];
  const contents = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(contents) as unknown[];
}

export function setDatabase(database: DatabaseClient | null): void {
  db = database;
}

export async function readAssetPrices(): Promise<ApiPrice[]> {
  if (db && db.isInitialized()) {
    try {
      const prices = await db.getAllLatestPrices();
      return prices.map((p: PriceHistory) => ({
        asset: p.asset,
        price: p.price,
        decimals: p.decimals,
        source: p.source,
        timestamp: p.timestamp,
      }));
    } catch (err) {
      console.error('Failed to read from database, falling back to files', err);
    }
  }

  const dir = DATA_DIR;
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.startsWith('history-'));
  const assets = new Map<string, ApiPrice>();

  for (const file of files) {
    try {
      const asset = file.replace('history-', '').replace('.json', '').toUpperCase();
      const data = readHistoryFile(path.join(dir, file));
      if (data.length > 0) {
        const latest = data[data.length - 1] as Record<string, unknown>;
        assets.set(asset, {
          asset,
          price: latest.price as string,
          decimals: latest.decimals as number,
          source: latest.source as string,
          timestamp: latest.timestamp as number,
        });
      }
    } catch { /* skip corrupt files */ }
  }

  return Array.from(assets.values());
}

export async function readPriceHistory(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): Promise<HistoricalPriceEntry[]> {
  if (from !== undefined && to !== undefined && from > to) return [];

  if (db && db.isInitialized()) {
    try {
      const history = await db.getHistoricalPrices(asset, from, to, limit);
      return history.map((h: PriceHistory) => ({
        price: h.price,
        decimals: h.decimals,
        source: h.source,
        timestamp: h.timestamp,
      }));
    } catch (err) {
      console.error('Failed to read from database, falling back to files', err);
    }
  }

  const filePath = path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);
  if (!fs.existsSync(filePath)) return [];

  try {
    let history = readHistoryFile(filePath) as HistoricalPriceEntry[];
    if (from) history = history.filter((h) => h.timestamp >= from);
    if (to) history = history.filter((h) => h.timestamp <= to);
    return history.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Cursor-based history fetch. The cursor encodes the timestamp of the last
 * returned record; the next page starts strictly after that timestamp.
 * Results are sorted ascending by timestamp.
 */
export async function readPriceHistoryCursor(
  asset: string,
  cursor: string | undefined,
  limit: number,
  to?: number,
): Promise<HistoricalPriceEntry[]> {
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded && to !== undefined && decoded.ts > to) return [];
  }

  let afterTs: number | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    afterTs = decoded?.ts;
  }

  if (db && db.isInitialized()) {
    try {
      const from = afterTs !== undefined ? afterTs + 1 : undefined;
      const history = await db.getHistoricalPrices(asset, from, to, limit);
      return history.map((h: PriceHistory) => ({
        price: h.price,
        decimals: h.decimals,
        source: h.source,
        timestamp: h.timestamp,
      }));
    } catch (err) {
      console.error('Failed to read from database for cursor query, falling back to files', err);
    }
  }

  const filePath = path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);
  if (!fs.existsSync(filePath)) return [];

  try {
    let history = readHistoryFile(filePath) as HistoricalPriceEntry[];
    history.sort((a, b) => a.timestamp - b.timestamp);
    if (afterTs !== undefined) history = history.filter((h) => h.timestamp > afterTs!);
    if (to !== undefined) history = history.filter((h) => h.timestamp <= to);
    return history.slice(0, limit + 1);
  } catch {
    return [];
  }
}
