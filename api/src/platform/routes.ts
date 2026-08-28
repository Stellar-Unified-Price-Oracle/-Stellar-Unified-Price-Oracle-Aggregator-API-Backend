import { Router, Request, Response } from 'express';
import {
  auditTrail,
  chaosExperiments,
  diagnose,
  getPlaybooks,
  metrics as selfHealingMetrics,
  postMortem,
  remediate,
} from './self-healing';
import {
  explainLineage,
  getLineage,
  listLineage,
  verifyLineage,
} from './lineage';
import {
  getPlugin,
  hostApi,
  installPlugin,
  invokePlugin,
  listPlugins,
  marketplace,
  removePlugin,
  setPluginActive,
  testPlugin,
  updatePlugin,
} from './plugins';
import { rateLimitStatus } from './rate-limiter';

const router = Router();

router.get('/plugins/host-api', (_req: Request, res: Response) => {
  res.json(hostApi());
});

router.get('/plugins/marketplace', (_req: Request, res: Response) => {
  res.json({ plugins: marketplace() });
});

router.get('/plugins', (_req: Request, res: Response) => {
  res.json({ plugins: listPlugins() });
});

router.post('/plugins', async (req: Request, res: Response) => {
  try {
    const record = await installPlugin(req.body.metadata || req.body, req.body.wasm || req.body.path || '');
    res.status(201).json(record);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put('/plugins/:id', async (req: Request, res: Response) => {
  try {
    const record = await updatePlugin(req.params.id, req.body.metadata || req.body, req.body.wasm || req.body.path);
    if (!record) return res.status(404).json({ error: 'plugin not found' });
    res.json(record);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.delete('/plugins/:id', (req: Request, res: Response) => {
  res.status(removePlugin(req.params.id) ? 204 : 404).send();
});

router.post('/plugins/:id/activate', (req: Request, res: Response) => {
  const record = setPluginActive(req.params.id, true);
  if (!record) return res.status(404).json({ error: 'plugin not found' });
  res.json(record);
});

router.post('/plugins/:id/deactivate', (req: Request, res: Response) => {
  const record = setPluginActive(req.params.id, false);
  if (!record) return res.status(404).json({ error: 'plugin not found' });
  res.json(record);
});

router.get('/plugins/:id/metrics', (req: Request, res: Response) => {
  const record = getPlugin(req.params.id);
  if (!record) return res.status(404).json({ error: 'plugin not found' });
  res.json(record.metrics);
});

router.post('/plugins/:id/invoke', async (req: Request, res: Response) => {
  try {
    res.json(await invokePlugin(req.params.id, req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/plugins/test', async (req: Request, res: Response) => {
  try {
    res.json(await testPlugin(req.body.wasm || req.body.path || ''));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/lineage/search', (req: Request, res: Response) => {
  res.json({ records: listLineage(req.query.asset as string | undefined, req.query.from as string | undefined, req.query.to as string | undefined) });
});

router.get('/lineage/verify/:provenanceId', (req: Request, res: Response) => {
  res.json(verifyLineage(req.params.provenanceId));
});

router.get('/lineage/:provenanceId/explanation', (req: Request, res: Response) => {
  const explanation = explainLineage(req.params.provenanceId);
  if (!explanation) return res.status(404).json({ error: 'lineage record not found' });
  res.json({ provenanceId: req.params.provenanceId, explanation, format: 'gdpr-right-to-explanation' });
});

router.get('/lineage/:provenanceId', (req: Request, res: Response) => {
  const record = getLineage(req.params.provenanceId);
  if (!record) return res.status(404).json({ error: 'lineage record not found' });
  res.json(record);
});

router.get('/self-healing/playbooks', (_req: Request, res: Response) => {
  res.json({ playbooks: getPlaybooks() });
});

router.post('/self-healing/diagnose', (req: Request, res: Response) => {
  res.json(diagnose(req.body));
});

router.post('/self-healing/remediate', (req: Request, res: Response) => {
  res.json(remediate(req.body));
});

router.get('/self-healing/metrics', (_req: Request, res: Response) => {
  res.json(selfHealingMetrics());
});

router.get('/self-healing/chaos-experiments', (_req: Request, res: Response) => {
  res.json({ experiments: chaosExperiments() });
});

router.post('/self-healing/postmortems/:incidentId', (req: Request, res: Response) => {
  const report = postMortem(req.params.incidentId);
  if (!report) return res.status(404).json({ error: 'incident not found' });
  res.json(report);
});

router.get('/self-healing/audit-trail', (_req: Request, res: Response) => {
  res.json({ auditTrail: auditTrail() });
});

router.get('/rate-limits/status', (_req: Request, res: Response) => {
  res.json(rateLimitStatus());
});

export default router;

