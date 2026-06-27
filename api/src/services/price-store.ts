import fs from 'fs';
import path from 'path';
import { DatabaseClient } from './database';

const DATA_DIR = path.resolve(__dirname, '../../data');
let db: DatabaseClient | null = null;

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
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
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
    let history = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (from) history = history.filter((h: any) => h.timestamp >= from);
    if (to) history = history.filter((h: any) => h.timestamp <= to);
    return history.slice(-limit);
  } catch {
    return [];
  }
}
