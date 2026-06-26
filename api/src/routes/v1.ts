import { z } from 'zod';
import { AssetQuerySchema, HistoryQuerySchema } from '../services/validation';
import { readAssetPrices, readPriceHistory } from '../services/price-store';
import { contractRegistry } from '../services/contract-registry';
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

router.get('/prices', async (req: Request, res: Response) => {
  try {
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

    const prices = await readAssetPrices();
    let result = prices;

    if (query.data.asset) {
      const normalizedAsset = query.data.asset.startsWith('C')
        ? query.data.asset
        : query.data.asset.toUpperCase();
      result = prices.filter((p) => p.asset === normalizedAsset);
    }

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
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch prices' }
    });
  }
});

router.get('/prices/:asset', async (req: Request, res: Response) => {
  try {
    const assetInput = req.params.asset;
    const asset = assetInput.startsWith('C') ? assetInput : assetInput.toUpperCase();
    const cacheKey = `price:${asset}`;
    const cached = pricesCache.get(cacheKey);
    if (cached) {
      cacheHitTotal.inc();
      return res.json({ success: true, data: cached, cached: true });
    }
    cacheMissTotal.inc();

    const prices = await readAssetPrices();
    const price = prices.find((p) => p.asset === asset);

    if (!price) {
      // For contract IDs, try to fetch metadata
      if (asset.startsWith('C')) {
        try {
          const metadata = await contractRegistry.getTokenMetadata(asset);
          if (metadata) {
            return res.json({
              success: true,
              data: {
                asset,
                symbol: metadata.symbol,
                name: metadata.name,
                decimals: metadata.decimals,
                price: null,
                status: 'no_price_data',
                timestamp: Math.floor(Date.now() / 1000),
              },
            });
          }
        } catch (error) {
          // Continue with error response
        }
      }

      return res.status(404).json({
        success: false,
        error: { code: 'ASSET_NOT_FOUND', message: `No price data for ${asset}` },
      });
    }

    priceQueriesTotal.inc({ asset });
    lastPriceTimestamp.set({ asset }, price.timestamp);
    pricesCache.set(cacheKey, price);
    res.json({ success: true, data: price });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch price' }
    });
  }
});

router.get('/history/:asset', async (req: Request, res: Response) => {
  try {
    const params = HistoryQuerySchema.safeParse({ ...req.params, ...req.query });
    if (!params.success) {
      return res.status(400).json({ success: false, error: params.error.flatten() });
    }

    const { asset, from, to, limit } = params.data;
    const history = await readPriceHistory(asset.toUpperCase(), from, to, limit);

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
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch history' }
    });
  }
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

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const prices = await readAssetPrices();
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
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch health status' }
    });
  }
});

export default router;
