import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(__dirname, '../../data');
const HISTORY_FILE = (asset: string) => path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
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
  if (fs.existsSync(filePath)) {
    try {
      history = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* ignore corrupt data */ }
  }
  history.push({ price, decimals, source, timestamp });
  fs.writeFileSync(filePath, JSON.stringify(history));
}

export function getHistoricalPrices(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): any[] {
  const filePath = HISTORY_FILE(asset);
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
