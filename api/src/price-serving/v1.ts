import {
  AssetQuerySchema,
  HistoryQuerySchema,
  CursorHistoryQuerySchema,
  OffsetQuerySchema,
  formatValidationResponse,
} from './validation';
import { readAssetPrices, readPriceHistory, readPriceHistoryCursor } from './price-store';
import { buildCursorMeta, applyOffsetPagination } from './pagination';
import type { ApiPrice } from '@stellar-oracle/types';
import { HybridCache } from './cache';
import { cacheHitTotal, cacheMissTotal, lastPriceTimestamp, priceQueriesTotal } from '../observability/metrics';
import { links, withLinks } from './hypermedia';
import { createLineageForPrice } from '../platform/lineage';
import { Router, Request, Response } from 'express';
import { conditionalCache } from './conditional-cache';
import { eventBus } from '../domain-events';
import complianceRoutes from '../governance/compliance';
import { issueWsCsrfToken, isCsrfEnabled } from '../infrastructure/csrf';
import { config } from '../infrastructure/config';
import { ok, okCached, fail } from '../infrastructure/response';

const router = Router();
let pricesCache: HybridCache<unknown>;

router.use(complianceRoutes);

export function initializeCache(cache: HybridCache<unknown>): void {
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
      wsToken: '/api/v1/ws-token',
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

router.get('/ws-token', (_req: Request, res: Response) => {
  if (!isCsrfEnabled()) {
    return res.status(503).json(
      fail({ code: 'WS_CSRF_DISABLED', message: 'WebSocket CSRF tokens are not enabled' }),
    );
  }

  const issuedAt = Date.now();
  res.json(
    ok({
      token: issueWsCsrfToken(),
      tokenType: 'Bearer',
      expiresInMs: config.ws.csrfTtlMs,
      expiresAt: new Date(issuedAt + config.ws.csrfTtlMs).toISOString(),
    }),
  );
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
    return res.json(okCached(cached));
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const filtered = assetQuery.data.asset
    ? prices.filter((p: ApiPrice) => p.asset === assetQuery.data.asset?.toUpperCase())
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

  const data = withLinks(
    {
      ...aggregated,
      prices: aggregated.prices.map((price) => ({
        ...price,
        lineage: createLineageForPrice(price as unknown as Record<string, unknown>, '/api/v1'),
      })),
    },
    links.prices(),
  );

  await pricesCache.set(cacheKey, data, 'prices');
  res.json(ok(data));
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
    return res.json(okCached(cached));
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const price = prices.find((p) => p.asset === asset);

  if (!price) {
    // Issue #218: a missing asset is a client error (404), not a server error.
    return res.status(404).json(
      fail({ code: 'PRICE_NOT_FOUND', message: 'Price not found for the requested asset' }),
    );
  }

  priceQueriesTotal.inc({ asset });
  lastPriceTimestamp.set({ asset }, price.timestamp);
  const data = withLinks(
    {
    ...price,
    lineage: createLineageForPrice(price as unknown as Record<string, unknown>, '/api/v1'),
    },
    links.asset(asset),
  );

  await pricesCache.set(cacheKey, data, 'price');
  res.json(ok(data));
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
    return res.json(okCached(cached));
  }
  cacheMissTotal.inc();

  const history = await readPriceHistoryCursor(upperAsset, cursor, limit, to);
  const page = history.length > limit ? history.slice(0, limit) : history;
  const pagination = buildCursorMeta(history, limit, 'timestamp');

  const response = {
    asset: upperAsset,
    to: to || null,
    prices: page,
    pagination,
  };

  await pricesCache.set(cacheKey, response, 'history');
  res.json(ok(response));
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
    return res.json(okCached(cached));
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
  res.json(ok(withLinks(response, links.history(asset))));
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
    return res.json(okCached(cached));
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
  res.json(ok(data));
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
    return res.json(okCached(cached));
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const hasStale = prices.some((p) => Date.now() / 1000 - p.timestamp > 120);
  const status = prices.length === 0 ? 'unhealthy' : hasStale ? 'degraded' : 'healthy';

  const data: Record<string, unknown> = {
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
  res.status(status === 'unhealthy' ? 503 : 200).json(ok(data));
});

export default router;
