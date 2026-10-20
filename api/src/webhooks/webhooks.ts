import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { isSsrfError } from '@stellar-oracle/ssrf-guard';
import {
  webhookService,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_FORMAT,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookRegistration,
} from './webhook-service';
import { links, withLinks } from '../price-serving/hypermedia';
import { sendError } from '../infrastructure/error';
import { describeUrlRejection } from './ssrf';

const router = Router();

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function notFound(res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Webhook resource not found' },
  });
}

const RegisterSchema = z.object({
  url: z.string().url(),
  trigger: z.object({
    type: z.enum(['threshold', 'interval']),
    asset: z.string().min(1),
    value: z.number().positive(),
  }),
});

const ReplaySchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
});

function keyPrefixOf(req: Request): string {
  return req.apiKey ? req.apiKey.substring(0, 8) : 'anonymous';
}

function publicView(
  webhook: WebhookRegistration,
): Omit<WebhookRegistration, 'secret' | 'verificationKey'> {
  const view = { ...webhook };
  delete (view as Partial<WebhookRegistration>).secret;
  delete (view as Partial<WebhookRegistration>).verificationKey;
  return view;
}

router.post('/', (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  let webhook: WebhookRegistration;
  try {
    webhook = webhookService.register(
      parsed.data.url,
      keyPrefixOf(req),
      { ...parsed.data.trigger, asset: parsed.data.trigger.asset.toUpperCase() },
    );
  } catch (err) {
    if (!isSsrfError(err)) throw err;
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_WEBHOOK_URL',
        message: describeUrlRejection(err),
        reason: err.reason,
      },
    });
  }

  res.status(201).json({
    success: true,
    data: {
      ...withLinks(publicView(webhook), links.webhook(webhook.id)),
      secret: webhook.secret,
      secretReturnedOnce: true,
      status: webhook.status,
      failureCount: webhook.failureCount,
      signature: {
        algorithm: WEBHOOK_SIGNATURE_ALGORITHM,
        header: WEBHOOK_SIGNATURE_HEADER,
        format: WEBHOOK_SIGNATURE_FORMAT,
      },
      message: 'Store the secret now: it is returned only in this response and is never readable again.',
    },
  });
});

router.get('/', (req: Request, res: Response) => {
  const data = webhookService.list(keyPrefixOf(req)).map((w: WebhookRegistration) => withLinks(publicView(w), links.webhook(w.id)));
  res.json({ success: true, data, _links: links.root() });
});

router.get('/verification-key', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      algorithm: WEBHOOK_SIGNATURE_ALGORITHM,
      signatureHeader: WEBHOOK_SIGNATURE_HEADER,
      signatureFormat: WEBHOOK_SIGNATURE_FORMAT,
      signedPayload:
        'The exact raw request body bytes (UTF-8) as delivered: JSON.stringify({ webhookId, ...payload }) with no spaces. Hash the bytes you received, never a re-serialised object.',
      signingKey:
        'Per-registration secret returned once by POST /api/v1/webhooks as "secret". This endpoint never returns key material.',
      verificationRecipe:
        'signature = "sha256=" + hex(HMAC-SHA256(secret, rawBody)); compare with a timing-safe equality against the X-Webhook-Signature header.',
      testVector: {
        secret: 'test-secret-0000000000000000000000000000',
        body: '{"webhookId":"00000000-0000-4000-8000-000000000001","asset":"XLM","price":0.42,"timestamp":1700000000}',
        signature: 'd285bbf58d70eff02a911f8bc9d9ce12592898054e5b52f868f7b1b53844c081',
        headerValue: 'sha256=d285bbf58d70eff02a911f8bc9d9ce12592898054e5b52f868f7b1b53844c081',
      },
      docs: 'docs/webhooks.md',
    },
  });
});

router.get('/dead-letters', asyncRoute(async (req, res) => {
  const data = await webhookService.listDeadLetters(keyPrefixOf(req));
  res.json({ success: true, data, _links: links.root() });
}));

router.get('/dead-letters/:id', asyncRoute(async (req, res) => {
  const entry = await webhookService.getDeadLetter(req.params.id);
  if (!entry || entry.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  res.json({ success: true, data: entry });
}));

router.post('/dead-letters/:id/replay', asyncRoute(async (req, res) => {
  const headerKey = req.header('Idempotency-Key');
  const parsed = ReplaySchema.safeParse({ idempotencyKey: req.body?.idempotencyKey ?? headerKey });
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'idempotencyKey is required (body field or Idempotency-Key header)',
      },
    });
    return;
  }

  const existing = await webhookService.getDeadLetter(req.params.id);
  if (!existing || existing.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }

  const result = await webhookService.replay(req.params.id, parsed.data.idempotencyKey);
  if (result.status === 'missing') {
    notFound(res);
    return;
  }
  if (result.status === 'failed') {
    res.status(502).json({
      success: false,
      error: { code: 'DELIVERY_FAILED', message: result.failure || 'Replay delivery failed' },
      data: result.entry,
    });
    return;
  }
  res.json({ success: true, data: { status: result.status, entry: result.entry } });
}));

router.get('/:id', (req: Request, res: Response) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  res.json({ success: true, data: withLinks(publicView(webhook), links.webhook(webhook.id)) });
});

router.delete('/:id', (req: Request, res: Response) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  webhookService.remove(req.params.id);
  res.status(204).send();
});

router.get('/:id/deliveries', asyncRoute(async (req, res) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : undefined;
  const sinceRaw = req.query.since;
  const since = typeof sinceRaw === 'string' ? parseInt(sinceRaw, 10) : undefined;
  const data = await webhookService.deliveries(req.params.id, {
    limit: Number.isFinite(limit) ? limit : undefined,
    since: Number.isFinite(since) ? since : undefined,
  });
  res.json({ success: true, data });
}));

export default router;
