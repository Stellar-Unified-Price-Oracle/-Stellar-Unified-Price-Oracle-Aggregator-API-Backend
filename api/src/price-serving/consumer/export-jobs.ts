import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { readPriceHistory } from '../price-store';
import { authMiddleware } from '../../governance/auth';
import { v2Ok, v2Fail } from '../../infrastructure/response';

export type ExportStatus = 'pending' | 'running' | 'completed' | 'failed' | 'expired';

export interface ExportJob {
  jobId: string;
  asset: string;
  status: ExportStatus;
  progress: number;
  totalRecords: number;
  processedRecords: number;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;
  downloadUrl?: string;
  error?: string;
  windowStart?: number;
  windowEnd?: number;
  recordCount?: number;
  checksum?: string;
}

const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EXPORT_RECORDS = 100000;
const jobs = new Map<string, ExportJob>();

const ExportCreateSchema = z.object({
  asset: z.string().min(1).describe('Asset symbol'),
  from: z.coerce.number().int().positive().optional().describe('Window start, Unix seconds'),
  to: z.coerce.number().int().positive().optional().describe('Window end, Unix seconds'),
  format: z.enum(['json', 'csv']).default('json').describe('Export format'),
});

function generateJobId(): string {
  return 'exp_' + Math.random().toString(36).slice(2, 14) + '_' + Date.now().toString(36);
}

function computeChecksum(records: unknown[]): string {
  const data = JSON.stringify(records);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash) + data.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

async function processExport(job: ExportJob): Promise<void> {
  try {
    job.status = 'running';
    const windowStart = job.windowStart ?? Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const windowEnd = job.windowEnd ?? Math.floor(Date.now() / 1000);
    const records = await readPriceHistory(job.asset, windowStart, windowEnd, MAX_EXPORT_RECORDS);
    job.totalRecords = Math.min(records.length, MAX_EXPORT_RECORDS);
    job.recordCount = job.totalRecords;
    const exportRecords = records.slice(0, MAX_EXPORT_RECORDS);
    for (let i = 0; i < exportRecords.length; i += 1000) {
      job.processedRecords = Math.min(i + 1000, exportRecords.length);
      job.progress = Math.round((job.processedRecords / exportRecords.length) * 100);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    job.status = 'completed';
    job.progress = 100;
    job.completedAt = Math.floor(Date.now() / 1000);
    job.downloadUrl = '/api/v1/consumer/exports/' + job.jobId + '/download';
    job.checksum = computeChecksum(exportRecords);
    job.error = undefined;
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : 'Export failed';
  }
}

const router = Router();
router.use(authMiddleware);

router.post('/', async (req: Request, res: Response) => {
  const parsed = ExportCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(v2Fail({ code: 'VALIDATION_ERROR', message: 'Invalid request body' }));
  }
  const { asset, from, to } = parsed.data;
  const jobId = generateJobId();
  const now = Math.floor(Date.now() / 1000);
  const job: ExportJob = {
    jobId,
    asset: asset.toUpperCase(),
    status: 'pending',
    progress: 0,
    totalRecords: 0,
    processedRecords: 0,
    createdAt: now,
    expiresAt: now + EXPORT_TTL_MS / 1000,
    windowStart: from,
    windowEnd: to,
  };
  jobs.set(jobId, job);
  void processExport(job);
  return res.status(202).json(v2Ok({
    jobId,
    status: 'pending',
    progress: 0,
    expiresAt: job.expiresAt,
    downloadUrl: null,
  }));
});

router.get('/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json(v2Fail({ code: 'EXPORT_NOT_FOUND', message: 'Export job not found' }));
  }
  if (job.status !== 'expired' && Date.now() / 1000 > job.expiresAt) {
    job.status = 'expired';
  }
  return res.json(v2Ok({
    jobId: job.jobId,
    asset: job.asset,
    status: job.status,
    progress: job.progress,
    totalRecords: job.totalRecords,
    processedRecords: job.processedRecords,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    expiresAt: job.expiresAt,
    downloadUrl: job.status === 'completed' ? job.downloadUrl : null,
    checksum: job.checksum,
    error: job.error,
  }));
});

router.get('/:jobId/download', async (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json(v2Fail({ code: 'EXPORT_NOT_FOUND', message: 'Export job not found' }));
  }
  if (job.status !== 'completed') {
    return res.status(400).json(v2Fail({
      code: 'EXPORT_NOT_READY',
      message: 'Export not ready (status: ' + job.status + ')',
    }));
  }
  if (Date.now() / 1000 > job.expiresAt) {
    job.status = 'expired';
    return res.status(410).json(v2Fail({ code: 'EXPORT_EXPIRED', message: 'Export has expired' }));
  }
  const windowStart = job.windowStart ?? Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const windowEnd = job.windowEnd ?? Math.floor(Date.now() / 1000);
  const records = (await readPriceHistory(job.asset, windowStart, windowEnd, MAX_EXPORT_RECORDS)).slice(0, MAX_EXPORT_RECORDS);
  const json = JSON.stringify({
    asset: job.asset,
    windowStart,
    windowEnd,
    recordCount: records.length,
    checksum: job.checksum,
    exportedAt: Math.floor(Date.now() / 1000),
    records,
  }, null, 2);
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', 'attachment; filename="export-' + job.asset + '-' + job.jobId + '.json"');
  res.set('X-Export-Checksum', job.checksum ?? '');
  res.set('X-Export-Record-Count', String(records.length));
  res.send(json);
});

export default router;
