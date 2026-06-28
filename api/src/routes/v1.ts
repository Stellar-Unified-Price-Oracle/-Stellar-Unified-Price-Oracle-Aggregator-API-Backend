import { AssetQuerySchema, HistoryQuerySchema, formatValidationResponse } from '../services/validation';
import { readAssetPrices, readPriceHistory } from '../services/price-store';
import { HybridCache } from '../services/cache';
import { cacheHitTotal, cacheMissTotal, lastPriceTimestamp, priceQueriesTotal } from '../middleware/metrics';
import { Router, Request, Response } from 'express';

const router = Router();
let pricesCache: HybridCache<any>;

export function initializeCache(cache: HybridCache<any>): void {
  pricesCache = cache;
}

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

router.get('/prices', async (req: Request, res: Response) => {
  const query = AssetQuerySchema.safeParse(req.query);
  if (!query.success) {
    return res.status(400).json(formatValidationResponse(query.error));
  }

  const cacheKey = `prices:${query.data.asset || '*'}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
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

  await pricesCache.set(cacheKey, aggregated, 'prices');
  res.json({ success: true, data: aggregated });
});

router.get('/prices/:asset', async (req: Request, res: Response) => {
  const asset = req.params.asset.toUpperCase();
  const cacheKey = `price:${asset}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const price = prices.find((p) => p.asset === asset);

  if (!price) {
    return res.status(404).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch price' }
    });
  }

  priceQueriesTotal.inc({ asset });
  lastPriceTimestamp.set({ asset }, price.timestamp);
  await pricesCache.set(cacheKey, price, 'price');
  res.json({ success: true, data: price });
});

router.get('/history/:asset', async (req: Request, res: Response) => {
  const params = HistoryQuerySchema.safeParse({ ...req.params, ...req.query });
  if (!params.success) {
    return res.status(400).json(formatValidationResponse(params.error));
  }

  const { asset, from, to, limit } = params.data;
  const cacheKey = `history:${asset.toUpperCase()}:${from || 0}:${to || 0}:${limit}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const history = await readPriceHistory(asset.toUpperCase(), from, to, limit);
  const response = {
    asset: asset.toUpperCase(),
    from: from || null,
    to: to || null,
    count: history.length,
    prices: history,
  };

  await pricesCache.set(cacheKey, response, 'history');
  res.json({ success: true, data: response });
});

router.get('/sources', async (_req: Request, res: Response) => {
  const cacheKey = 'sources:all';
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const data = {
    sources: [
      { name: 'Chainlink', active: true, type: 'off-chain', website: 'https://chain.link' },
      { name: 'Redstone', active: true, type: 'off-chain', website: 'https://redstone.finance' },
      { name: 'Band Protocol', active: true, type: 'off-chain', website: 'https://bandprotocol.com' },
      { name: 'Reflector', active: true, type: 'off-chain', website: 'https://reflector.xyz' },
    ],
  };

  await pricesCache.set(cacheKey, data, 'sources');
  res.json({ success: true, data });
});

router.get('/health', async (_req: Request, res: Response) => {
  const cacheKey = 'health:status';
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const status = prices.length > 0 ? 'healthy' : 'degraded';

  const data = {
    service: 'stellar-price-oracle-api',
    status,
    uptime: process.uptime(),
    timestamp: Math.floor(Date.now() / 1000),
    assetsTracked: prices.length,
  };

  await pricesCache.set(cacheKey, data, 'health');
  res.json({ success: true, data });
});

export default router;
