import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { webhookService } from './webhook-service';
import { links, withLinks } from '../price-serving/hypermedia';

const router = Router();

const RegisterSchema = z.object({
  url: z.string().url(),
  trigger: z.object({
    type: z.enum(['threshold', 'interval']),
    asset: z.string().min(1),
    value: z.number().positive(),
  }),
});

function keyPrefixOf(req: Request): string {
  return req.apiKey ? req.apiKey.substring(0, 8) : 'anonymous';
}

router.post('/', (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  const webhook = webhookService.register(
    parsed.data.url,
    keyPrefixOf(req),
    { ...parsed.data.trigger, asset: parsed.data.trigger.asset.toUpperCase() },
  );

  res.status(201).json({ success: true, data: withLinks(webhook, links.webhook(webhook.id)) });
});

router.get('/', (req: Request, res: Response) => {
  const data = webhookService.list(keyPrefixOf(req)).map((w: any) => withLinks(w, links.webhook(w.id)));
  res.json({ success: true, data, _links: links.root() });
});

router.get('/:id', (req: Request, res: Response) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
  }
  res.json({ success: true, data: withLinks(webhook, links.webhook(webhook.id)) });
});

router.delete('/:id', (req: Request, res: Response) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
  }
  webhookService.remove(req.params.id);
  res.status(204).send();
});

router.get('/:id/deliveries', (req: Request, res: Response) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
  }
  res.json({ success: true, data: webhookService.deliveries(req.params.id) });
});

export default router;
