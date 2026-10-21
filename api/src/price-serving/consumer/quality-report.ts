import { createHash } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../governance/auth';
import { v2Fail, v2Ok } from '../../infrastructure/response';
import { buildQualityReport } from './store';

const router = Router();
const querySchema = z.object({
  assets: z.string().min(1).max(1000),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  region: z.string().trim().min(1).max(64).optional(),
});

router.use(authMiddleware);
router.get('/', (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json(v2Fail({ code: 'VALIDATION_ERROR', message: 'assets, from, and to are required' }));
  const { assets: rawAssets, from, to, region } = parsed.data;
  const assets = rawAssets.split(',').map((asset) => asset.trim()).filter(Boolean);
  if (!assets.length || assets.length > 50 || assets.some((asset) => !/^[A-Za-z0-9:_-]{1,64}$/.test(asset))) {
    return res.status(400).json(v2Fail({ code: 'INVALID_ASSETS', message: 'Provide 1 to 50 valid comma-separated feed identifiers' }));
  }
  if (to <= from || to - from > 30 * 24 * 60 * 60) {
    return res.status(400).json(v2Fail({ code: 'INVALID_WINDOW', message: 'to must be after from and the window cannot exceed 30 days' }));
  }
  const report = buildQualityReport(assets, from, to, region?.toLowerCase());
  const reportId = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return res.json(v2Ok({ ...report, reportId, generatedAt: Math.floor(Date.now() / 1000) }));
});

export default router;
