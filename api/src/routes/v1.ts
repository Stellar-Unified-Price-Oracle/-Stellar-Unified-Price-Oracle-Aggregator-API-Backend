import { AssetQuerySchema, HistoryQuerySchema } from '../services/validation';
import { readAssetPrices, readPriceHistory } from '../services/price-store';
import { LRUCache } from '../services/cache';
import { cacheHitTotal, cacheMissTotal, lastPriceTimestamp, priceQueriesTotal } from '../middleware/metrics';
import { Router, Request, Response } from 'express';

const router = Router();
const pricesCache = new LRUCache<any>(100, 15000);

router.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Stellar Unified Price Oracle & Aggregator API',
    version: '1.0.0',
    endpoints: {
      prices: '/api/v1/prices',
      price: '/api/v1/prices/:asset',
      history: '/api/v1/history/:asset',
      sources: '/api/v1/sources',
      health: '/api/v1/health',
      docs: '/api/v1/docs',
      metrics: '/metrics',
    },
  });
});

router.get('/prices', (req: Request, res: Response) => {
  const query = AssetQuerySchema.safeParse(req.query);
  if (!query.success) {
    return res.status(400).json({ success: false, error: query.error.flatten() });
  }

  const cacheKey = `prices:${query.data.asset || '*'}`;
  const cached = pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const prices = readAssetPrices();
  const result = query.data.asset
    ? prices.filter((p) => p.asset === query.data.asset?.toUpperCase())
    : prices;

  for (const p of result) {
    priceQueriesTotal.inc({ asset: p.asset });
    lastPriceTimestamp.set({ asset: p.asset }, p.timestamp);
  }

  const aggregated = {
    timestamp: Math.floor(Date.now() / 1000),
    count: result.length,
    prices: result,
  };

  pricesCache.set(cacheKey, aggregated);
  res.json({ success: true, data: aggregated });
});

router.get('/prices/:asset', (req: Request, res: Response) => {
  const asset = req.params.asset.toUpperCase();
  const cacheKey = `price:${asset}`;
  const cached = pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const prices = readAssetPrices();
  const price = prices.find((p) => p.asset === asset);

  if (!price) {
    return res.status(404).json({
      success: false,
      error: { code: 'ASSET_NOT_FOUND', message: `No price data for ${asset}` },
    });
  }

  priceQueriesTotal.inc({ asset });
  lastPriceTimestamp.set({ asset }, price.timestamp);
  pricesCache.set(cacheKey, price);
  res.json({ success: true, data: price });
});

router.get('/history/:asset', (req: Request, res: Response) => {
  const params = HistoryQuerySchema.safeParse({ ...req.params, ...req.query });
  if (!params.success) {
    return res.status(400).json({ success: false, error: params.error.flatten() });
  }

  const { asset, from, to, limit } = params.data;
  const history = readPriceHistory(asset.toUpperCase(), from, to, limit);

  res.json({
    success: true,
    data: {
      asset: asset.toUpperCase(),
      from: from || null,
      to: to || null,
      count: history.length,
      prices: history,
    },
  });
});

router.get('/sources', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      sources: [
        { name: 'Chainlink', active: true, type: 'off-chain', website: 'https://chain.link' },
        { name: 'Redstone', active: true, type: 'off-chain', website: 'https://redstone.finance' },
        { name: 'Band Protocol', active: true, type: 'off-chain', website: 'https://bandprotocol.com' },
        { name: 'Reflector', active: true, type: 'off-chain', website: 'https://reflector.xyz' },
      ],
    },
  });
});

router.get('/health', (_req: Request, res: Response) => {
  const prices = readAssetPrices();
  const status = prices.length > 0 ? 'healthy' : 'degraded';

  res.json({
    success: true,
    data: {
      service: 'stellar-price-oracle-api',
      status,
      uptime: process.uptime(),
      timestamp: Math.floor(Date.now() / 1000),
      assetsTracked: prices.length,
    },
  });
});

export default router;
