import { Router } from 'express';
import latencyFreshnessRoutes from './latency-freshness';
import snapshotRoutes from './snapshot-signer';
import feedCatalogRoutes from './feed-catalog-consumer';
import exportJobsRoutes from './export-jobs';
import usageExportRoutes from './usage-export';
import deliveryObjectivesRoutes from './delivery-objectives';
import qualityReportRoutes from './quality-report';
import schemaRegistryRoutes from './schema-registry';

const router = Router();

router.use('/latency-freshness', latencyFreshnessRoutes);
router.use('/snapshots', snapshotRoutes);
router.use('/feeds', feedCatalogRoutes);
router.use('/exports', exportJobsRoutes);
router.use('/usage/export', usageExportRoutes);
router.use('/delivery-objectives', deliveryObjectivesRoutes);
router.use('/quality-report', qualityReportRoutes);
router.use('/schemas', schemaRegistryRoutes);

export default router;
