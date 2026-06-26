import fs from 'fs';
import path from 'path';
import { priceRepository } from './price-repository';
import { isDbAvailable } from './database';

const DATA_DIR = path.resolve(__dirname, '../../data');

export async function readAssetPrices(): Promise<any[]> {
  // Try database first if available
  if (isDbAvailable()) {
    try {
      const assets = await priceRepository.getAllAssets();
      const result = [];
      for (const asset of assets) {
        const latest = await priceRepository.getLatestPrice(asset);
        if (latest) {
          result.push({
            asset: latest.asset,
            price: latest.price,
            decimals: latest.decimals,
            source: latest.source,
            timestamp: latest.timestamp,
          });
        }
      }
      return result;
    } catch (error) {
      // Fall through to file-based storage
    }
  }

  // Fall back to file-based storage
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
  // Try database first if available
  if (isDbAvailable()) {
    try {
      const history = await priceRepository.getPriceHistory(asset, from, to, limit);
      return history;
    } catch (error) {
      // Fall through to file-based storage
    }
  }

  // Fall back to file-based storage
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
