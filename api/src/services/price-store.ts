import fs from 'fs';
import path from 'path';
import { DatabaseClient } from './database';
import { decrypt, isEncrypted } from './crypto';

const DATA_DIR = path.resolve(__dirname, '../../data');
let db: DatabaseClient | null = null;

/** Read and parse a history file, transparently decrypting if encrypted at rest. */
function readHistoryFile(filePath: string): any[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw) return [];
  const contents = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(contents);
}

export function setDatabase(database: DatabaseClient | null): void {
  db = database;
}

export async function readAssetPrices(): Promise<any[]> {
  if (db && db.isInitialized()) {
    try {
      const prices = await db.getAllLatestPrices();
      return prices.map((p) => ({
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
  const assets = new Map<string, any>();

  for (const file of files) {
    try {
      const asset = file.replace('history-', '').replace('.json', '').toUpperCase();
      const data = readHistoryFile(path.join(dir, file));
      if (data.length > 0) {
        const latest = data[data.length - 1];
        assets.set(asset, {
          asset,
          price: latest.price,
          decimals: latest.decimals,
          source: latest.source,
          timestamp: latest.timestamp,
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
): Promise<any[]> {
  if (db && db.isInitialized()) {
    try {
      const history = await db.getHistoricalPrices(asset, from, to, limit);
      return history.map((h) => ({
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
    let history = readHistoryFile(filePath);
    if (from) history = history.filter((h: any) => h.timestamp >= from);
    if (to) history = history.filter((h: any) => h.timestamp <= to);
    return history.slice(-limit);
  } catch {
    return [];
  }
}
