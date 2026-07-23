import {
  AssetQuerySchema,
  HistoryQuerySchema,
  CursorHistoryQuerySchema,
  OffsetQuerySchema,
  formatValidationResponse,
} from './validation';
import { readAssetPrices, readPriceHistory, readPriceHistoryCursor } from './price-store';
import { buildCursorMeta, applyOffsetPagination } from './pagination';
import { HybridCache } from './cache';
import { cacheHitTotal, cacheMissTotal, lastPriceTimestamp, priceQueriesTotal } from '../observability/metrics';
import { issueWsCsrfToken, isCsrfEnabled } from '../infrastructure/csrf';
import { config } from '../infrastructure/config';
import { links, withLinks } from './hypermedia';
import { Router, Request, Response } from 'express';
import { conditionalCache } from './conditional-cache';
import { eventBus } from '../domain-events';

const router = Router();
let pricesCache: HybridCache<any>;

export function initializeCache(cache: HybridCache<any>): void {
  pricesCache = cache;
}

router.use(['/prices', '/prices/:asset'], conditionalCache);

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
      healthLive: '/api/v1/health/live',
      healthReady: '/api/v1/health/ready',
      docs: '/api/v1/docs',
      portal: '/portal',
      metrics: '/metrics',
    },
    pagination: {
      history: 'cursor-based (?cursor=<token>&limit=50)',
      sources: 'offset-based (?page=1&limit=20)',
      prices: 'offset-based (?page=1&limit=20)',
    },
  });
});

// GET /prices — offset-paginated list of all asset prices
router.get('/prices', async (req: Request, res: Response) => {
  const assetQuery = AssetQuerySchema.safeParse(req.query);
  if (!assetQuery.success) {
    return res.status(400).json(formatValidationResponse(assetQuery.error));
  }

  const pageQuery = OffsetQuerySchema.safeParse(req.query);
  if (!pageQuery.success) {
    return res.status(400).json(formatValidationResponse(pageQuery.error));
  }

  // Publish PriceRequestedEvent
  eventBus.publish({
    type: 'price-requested',
    payload: {
      asset: assetQuery.data.asset,
      ip: req.ip,
    },
    timestamp: Date.now(),
  });

  const { page, limit } = pageQuery.data;
  const cacheKey = `prices:${assetQuery.data.asset || '*'}:p${page}:l${limit}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const filtered = assetQuery.data.asset
    ? prices.filter((p) => p.asset === assetQuery.data.asset?.toUpperCase())
    : prices;

  for (const p of filtered) {
    priceQueriesTotal.inc({ asset: p.asset });
    lastPriceTimestamp.set({ asset: p.asset }, p.timestamp);
  }

  const { items: paged, meta: pagination } = applyOffsetPagination(filtered, page, limit);

  const aggregated = {
    timestamp: Math.floor(Date.now() / 1000),
    prices: paged,
    pagination,
  };

  await pricesCache.set(cacheKey, aggregated, 'prices');
  res.json({ success: true, data: withLinks(aggregated, links.prices()) });
});

router.get('/prices/:asset', async (req: Request, res: Response) => {
  const asset = req.params.asset.toUpperCase();
  
  // Publish PriceRequestedEvent
  eventBus.publish({
    type: 'price-requested',
    payload: {
      asset,
      ip: req.ip,
    },
    timestamp: Date.now(),
  });

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
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch price' },
    });
  }

  priceQueriesTotal.inc({ asset });
  lastPriceTimestamp.set({ asset }, price.timestamp);
  await pricesCache.set(cacheKey, price, 'price');
  res.json({ success: true, data: withLinks(price, links.asset(asset)) });
});

// GET /history/:asset — cursor-paginated time-series
router.get('/history/:asset', async (req: Request, res: Response) => {
  const cursorParams = CursorHistoryQuerySchema.safeParse({ ...req.params, ...req.query });
  if (!cursorParams.success) {
    return res.status(400).json(formatValidationResponse(cursorParams.error));
  }

  const { asset, cursor, limit, to } = cursorParams.data;
  const upperAsset = asset.toUpperCase();

  // Publish PriceHistoryRequestedEvent
  eventBus.publish({
    type: 'price-history-requested',
    payload: {
      asset: upperAsset,
      ip: req.ip,
    },
    timestamp: Date.now(),
  });

  const cacheKey = `history:${upperAsset}:c${cursor || ''}:l${limit}:t${to || 0}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const history = await readPriceHistoryCursor(upperAsset, cursor, limit, to);
  const pagination = buildCursorMeta(history, limit, 'timestamp');

  const response = {
    asset: upperAsset,
    to: to || null,
    prices: history,
    pagination,
  };

  await pricesCache.set(cacheKey, response, 'history');
  res.json({ success: true, data: response });
});

// GET /history/:asset/legacy — original non-paginated endpoint kept for backward compatibility
router.get('/history/:asset/legacy', async (req: Request, res: Response) => {
  const params = HistoryQuerySchema.safeParse({ ...req.params, ...req.query });
  if (!params.success) {
    return res.status(400).json(formatValidationResponse(params.error));
  }

  const { asset, from, to, limit } = params.data;
  const upperAsset = asset.toUpperCase();

  // Publish PriceHistoryRequestedEvent
  eventBus.publish({
    type: 'price-history-requested',
    payload: {
      asset: upperAsset,
      ip: req.ip,
    },
    timestamp: Date.now(),
  });

  const cacheKey = `history:legacy:${upperAsset}:${from || 0}:${to || 0}:${limit}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const history = await readPriceHistory(upperAsset, from, to, limit);
  const response = {
    asset: upperAsset,
    from: from || null,
    to: to || null,
    count: history.length,
    prices: history,
  };

  await pricesCache.set(cacheKey, response, 'history');
  res.json({ success: true, data: withLinks(response, links.history(asset)) });
});

// GET /sources — offset-paginated
router.get('/sources', async (req: Request, res: Response) => {
  const pageQuery = OffsetQuerySchema.safeParse(req.query);
  if (!pageQuery.success) {
    return res.status(400).json(formatValidationResponse(pageQuery.error));
  }

  const { page, limit } = pageQuery.data;
  const cacheKey = `sources:p${page}:l${limit}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const allSources = [
    { name: 'Chainlink', active: true, type: 'off-chain', website: 'https://chain.link' },
    { name: 'Redstone', active: true, type: 'off-chain', website: 'https://redstone.finance' },
    { name: 'Band Protocol', active: true, type: 'off-chain', website: 'https://bandprotocol.com' },
    { name: 'Reflector', active: true, type: 'off-chain', website: 'https://reflector.xyz' },
  ];

  const { items: sources, meta: pagination } = applyOffsetPagination(allSources, page, limit);
  const data = { sources, pagination };

  await pricesCache.set(cacheKey, data, 'sources');
  res.json({ success: true, data });
});

router.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'alive', uptime: process.uptime() });
});

router.get('/health/ready', async (_req: Request, res: Response) => {
  const prices = await readAssetPrices();
  const ready = prices.length > 0;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', assetsTracked: prices.length });
});

router.get('/health', async (req: Request, res: Response) => {
  const verbose = req.query.verbose === 'true';
  const cacheKey = `health:status:${verbose}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ success: true, data: cached, cached: true });
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const hasStale = prices.some((p) => Date.now() / 1000 - p.timestamp > 120);
  const status = prices.length === 0 ? 'unhealthy' : hasStale ? 'degraded' : 'healthy';

  const data: Record<string, any> = {
    service: 'stellar-price-oracle-api',
    status,
    uptime: process.uptime(),
    timestamp: Math.floor(Date.now() / 1000),
    assetsTracked: prices.length,
    degradedAssets: prices.filter((p) => Date.now() / 1000 - p.timestamp > 120).map((p) => p.asset),
    endpoints: {
      liveness: '/api/v1/health/live',
      readiness: '/api/v1/health/ready',
    },
  };

  if (verbose) {
    data.prices = prices.map((p) => ({
      asset: p.asset,
      timestamp: p.timestamp,
      sources: p.sources,
      stale: Date.now() / 1000 - p.timestamp > 120,
    }));
    data.processMemoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    data.nodeVersion = process.version;
  }

  await pricesCache.set(cacheKey, data, 'health');
  res.status(status === 'unhealthy' ? 503 : 200).json({ success: true, data });
});

export default router;
