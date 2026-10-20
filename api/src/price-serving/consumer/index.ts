import { Router } from 'express';
import latencyFreshnessRoutes from './latency-freshness';
import usageExportRoutes from './usage-export';
import deliveryObjectivesRoutes from './delivery-objectives';

const router = Router();

router.use('/latency-freshness', latencyFreshnessRoutes);
router.use('/usage/export', usageExportRoutes);
router.use('/delivery-objectives', deliveryObjectivesRoutes);

export default router;