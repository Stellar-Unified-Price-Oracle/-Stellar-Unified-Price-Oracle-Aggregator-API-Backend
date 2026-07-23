import { Router, Request, Response } from 'express';
import { usageAnalytics } from '../services/usage-analytics';

const router = Router();

router.get('/reports', (req: Request, res: Response) => {
  const period = (req.query.period as string) || 'daily';
  if (!['daily', 'weekly', 'monthly'].includes(period)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'period must be one of daily, weekly, monthly' },
    });
  }
  res.json({ success: true, data: usageAnalytics.report(period as 'daily' | 'weekly' | 'monthly') });
});

router.get('/dashboard', (_req: Request, res: Response) => {
  res.json({ success: true, data: usageAnalytics.dashboard() });
});

router.get('/anomalies', (req: Request, res: Response) => {
  const threshold = req.query.threshold ? Number(req.query.threshold) : 3;
  const lookbackHours = req.query.lookbackHours ? Number(req.query.lookbackHours) : undefined;
  const anomalies = usageAnalytics.detectAnomalies(threshold, lookbackHours);
  res.json({ success: true, data: { anomalies, count: anomalies.length } });
});

export default router;
