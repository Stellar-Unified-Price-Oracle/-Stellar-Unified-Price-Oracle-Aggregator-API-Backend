import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(__dirname, '../../data');

export function readAssetPrices(): any[] {
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

export function readPriceHistory(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): any[] {
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
