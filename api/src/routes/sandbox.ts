import { Router, Request, Response } from 'express';
import { config } from '../infrastructure/config';
import { HybridCache } from '../price-serving/cache';
import { readAssetPrices, readPriceHistory, resetSandboxData, SANDBOX_ASSETS } from '../price-serving/price-store';

const router = Router();
let sandboxCache: HybridCache<unknown> | undefined;

export function initializeSandboxCache(cache: HybridCache<unknown>): void {
  sandboxCache = cache;
}
const READ_ONLY_PATH = /^\/(prices(?:\/[A-Z0-9]{1,12})?|history\/[A-Z0-9]{1,12}|sources|health(?:\/live|\/ready)?)$/;

function disabled(res: Response): Response {
  return res.status(404).json({ error: 'Sandbox endpoints are disabled.' });
}

router.get('/info', (_req: Request, res: Response) => {
  if (!config.sandbox.enabled) return disabled(res);
  res.json({
    environment: 'sandbox',
    productionIsolation: true,
    assets: SANDBOX_ASSETS,
    limitations: ['Data is synthetic and must not be used for financial decisions.', 'Requests are read-only and resettable.', 'Sandbox credentials and endpoints are separate from production.'],
    reset: 'POST /api/v1/sandbox/reset with x-sandbox-reset-token',
    replay: 'POST /api/v1/sandbox/replay with {"path":"/prices/XLM"}',
  });
});

router.post('/reset', async (req: Request, res: Response) => {
  if (!config.sandbox.enabled) return disabled(res);
  if (!config.sandbox.resetToken || req.header('x-sandbox-reset-token') !== config.sandbox.resetToken) {
    return res.status(403).json({ error: 'A valid sandbox reset token is required.' });
  }
  resetSandboxData();
  await sandboxCache?.invalidate('*');
  return res.json({ reset: true, environment: 'sandbox', assets: SANDBOX_ASSETS, resetAt: new Date().toISOString() });
});

router.post('/replay', async (req: Request, res: Response) => {
  if (!config.sandbox.enabled) return disabled(res);
  const path = typeof req.body?.path === 'string' ? req.body.path : '';
  const match = READ_ONLY_PATH.exec(path);
  if (!match || req.body?.method && req.body.method !== 'GET') {
    return res.status(400).json({ error: 'Only sandbox read requests can be replayed.', allowed: READ_ONLY_PATH.source });
  }
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'prices') {
    const prices = await readAssetPrices();
    return res.json({ replayed: true, method: 'GET', path, response: parts[1] ? prices.find((price) => price.asset === parts[1]) || null : prices });
  }
  if (parts[0] === 'history') {
    return res.json({ replayed: true, method: 'GET', path, response: await readPriceHistory(parts[1]) });
  }
  return res.json({ replayed: true, method: 'GET', path, response: { environment: 'sandbox', status: 'ok' } });
});

export default router;
