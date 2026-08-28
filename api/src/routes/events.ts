/**
 * #118 — Event sourcing read-side API
 *
 * GET  /api/events                 — list recent events (admin)
 * GET  /api/events/projections/latest-prices — rebuilt latest-price read model
 * GET  /api/events/stream/:id      — events for a specific aggregate stream
 */

import { Router, Request, Response } from 'express';
import {
  globalEventStore,
  globalProjectionEngine,
  latestPriceProjection,
} from '../services/eventStore';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const events = await globalEventStore.readAll();
  res.json({
    total: events.length,
    events: events.slice(-100), // last 100
  });
});

router.get('/projections/latest-prices', async (_req: Request, res: Response) => {
  const readModel = await globalProjectionEngine.rebuild(latestPriceProjection);
  res.json({ readModel, generatedAt: new Date().toISOString() });
});

router.get('/stream/:id', async (req: Request, res: Response) => {
  const streamId = decodeURIComponent(req.params.id);
  const from = parseInt((req.query.from as string) || '1', 10);
  const events = await globalEventStore.readStream(streamId, from);
  if (events.length === 0 && from === 1) {
    res.status(404).json({ error: 'Stream not found or empty', streamId });
    return;
  }
  res.json({ streamId, events });
});

export default router;
