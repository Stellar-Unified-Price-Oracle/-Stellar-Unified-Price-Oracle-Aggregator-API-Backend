/**
 * #118 — Event sourcing read-side API
 *
 * GET  /api/events                 — list recent events (admin)
 * GET  /api/events/projections/latest-prices — rebuilt latest-price read model
 * GET  /api/events/stream/:id      — events for a specific aggregate stream
 * GET  /api/events/contract        — decoded Soroban contract events (#728)
 *
 * #728 — Soroban event decoding client library
 * ---------------------------------------------
 * `GET /api/events/contract` serves contract events decoded into typed records
 * via the shared `sorobanEventDecoder` library. The decoder verifies the event
 * schema version against the supported range and rejects incompatible events.
 *
 * Query parameters:
 *   - `limit`   (optional, default 100, max 500) — number of most recent events
 *   - `stream`  (optional) — restrict to a single aggregate stream id
 *   - `from`    (optional, default 1) — sequence to read from when `stream` set
 *
 * Response (200):
 *   {
 *     total: number,
 *     decoded: DecodedContractEvent[],
 *     skipped: number,          // events that were not contract events
 *     generatedAt: string,
 *   }
 *
 * Error response (422) when one or more events use an incompatible schema
 * version:
 *   {
 *     error: 'Incompatible event version',
 *     details: [{ eventId, version, supported: { min, max } }],
 *     supported: { min, max },
 *   }
 *
 * Monitoring:
 *   - Emit a counter `soroban_event_decode_total{status}` (ok|skipped|incompatible)
 *     from the handler so dashboards can alert on incompatible-version spikes.
 *   - Log a structured warning (event id + version) for every incompatible event.
 *
 * Rollout / rollback:
 *   - Rollout: deploy the decoder library and this route together. The route is
 *     additive and does not alter existing endpoints. Clients should be pointed
 *     at `/api/events/contract` only after the decoder version range has been
 *     verified against the current network protocol version.
 *   - Rollback: remove/disable the `/contract` route (feature-flag or revert).
 *     Existing endpoints (`/`, `/stream/:id`, `/projections/latest-prices`) are
 *     unaffected, so rollback is safe and non-destructive.
 */

import { Router, Request, Response } from 'express';
import {
  globalEventStore,
  globalProjectionEngine,
  latestPriceProjection,
} from '../services/eventStore';
import {
  sorobanEventDecoder,
  DecodedContractEvent,
  IncompatibleEventVersionError,
  SUPPORTED_EVENT_VERSION_RANGE,
} from '../services/sorobanEventDecoder';

const router = Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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

/**
 * #728 — Decoded Soroban contract events.
 *
 * NOTE: registered before `/stream/:id` is not required since the paths differ,
 * but it is intentionally declared after the static routes for readability.
 */
router.get('/contract', async (req: Request, res: Response) => {
  const rawLimit = parseInt((req.query.limit as string) || String(DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const streamId = req.query.stream ? decodeURIComponent(req.query.stream as string) : undefined;
  const from = parseInt((req.query.from as string) || '1', 10);

  let sourceEvents;
  if (streamId) {
    sourceEvents = await globalEventStore.readStream(streamId, from);
  } else {
    const all = await globalEventStore.readAll();
    sourceEvents = all.slice(-limit);
  }

  const decoded: DecodedContractEvent[] = [];
  const incompatible: Array<{ eventId: string; version: number }> = [];
  let skipped = 0;

  for (const event of sourceEvents) {
    if (!sorobanEventDecoder.isContractEvent(event)) {
      skipped += 1;
      continue;
    }
    try {
      decoded.push(sorobanEventDecoder.decode(event));
    } catch (err) {
      if (err instanceof IncompatibleEventVersionError) {
        incompatible.push({ eventId: err.eventId, version: err.version });
        // Structured warning for monitoring/alerting.
        // eslint-disable-next-line no-console
        console.warn('[soroban-event-decoder] incompatible event version', {
          eventId: err.eventId,
          version: err.version,
          supported: SUPPORTED_EVENT_VERSION_RANGE,
        });
        continue;
      }
      throw err;
    }
  }

  if (incompatible.length > 0) {
    res.status(422).json({
      error: 'Incompatible event version',
      details: incompatible,
      supported: SUPPORTED_EVENT_VERSION_RANGE,
    });
    return;
  }

  res.json({
    total: decoded.length,
    decoded,
    skipped,
    generatedAt: new Date().toISOString(),
  });
});

export default router;