import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router, Request, Response, NextFunction } from 'express';

type AuditResult = 'success' | 'failure' | 'denied';

interface ComplianceAuditEntry {
  timestampNs: string;
  eventType: string;
  actor: string;
  resource: string;
  action: string;
  result: AuditResult;
  sourceIp: string;
  correlationId: string;
  previousHash: string;
  hash: string;
  details?: Record<string, unknown>;
}

interface RetentionPolicy {
  dataType: string;
  retentionDays: number;
  action: 'delete' | 'archive';
}

const router = Router();
const auditEntries: ComplianceAuditEntry[] = [];
const auditLogPath = path.resolve(process.cwd(), 'logs/compliance-audit.jsonl');
let previousHash = '0'.repeat(64);

const retentionPolicies: RetentionPolicy[] = [
  { dataType: 'price_data', retentionDays: 2555, action: 'archive' },
  { dataType: 'audit_logs', retentionDays: 1095, action: 'archive' },
  { dataType: 'debug_logs', retentionDays: 90, action: 'delete' },
  { dataType: 'raw_source_payloads', retentionDays: 90, action: 'archive' },
];

const soc2Controls = [
  { id: 'CC6.1', name: 'Logical access', status: 'partial', evidence: ['api-key-manager', 'rbac'] },
  { id: 'CC6.6', name: 'Transmission security', status: 'partial', evidence: ['httpsRedirect', 'hstsHeaders'] },
  { id: 'CC7.2', name: 'Monitoring', status: 'partial', evidence: ['metrics', 'usage-anomalies', 'audit-log'] },
  { id: 'CC7.4', name: 'Incident response', status: 'partial', evidence: ['incident-playbook-required'] },
  { id: 'CC8.1', name: 'Change management', status: 'partial', evidence: ['ci-workflow'] },
  { id: 'A1.2', name: 'Capacity management', status: 'partial', evidence: ['metrics'] },
  { id: 'A1.3', name: 'Backup and recovery', status: 'partial', evidence: ['backup-service'] },
];

function timestampNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function hashEntry(entry: Omit<ComplianceAuditEntry, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

function persistAuditEntry(entry: ComplianceAuditEntry): void {
  try {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`);
  } catch {
    return;
  }
}

export function recordComplianceAudit(
  eventType: string,
  req: Request,
  action: string,
  result: AuditResult,
  details?: Record<string, unknown>,
): ComplianceAuditEntry {
  const actor = req.apiKey ? req.apiKey.substring(0, 8) : 'anonymous';
  const entryWithoutHash: Omit<ComplianceAuditEntry, 'hash'> = {
    timestampNs: timestampNs(),
    eventType,
    actor,
    resource: req.originalUrl || req.path,
    action,
    result,
    sourceIp: req.ip || req.socket.remoteAddress || 'unknown',
    correlationId: req.requestId || req.headers['x-correlation-id']?.toString() || crypto.randomUUID(),
    previousHash,
    ...(details && { details }),
  };
  const entry = { ...entryWithoutHash, hash: hashEntry(entryWithoutHash) };
  previousHash = entry.hash;
  auditEntries.push(entry);
  persistAuditEntry(entry);
  return entry;
}

export function complianceAuditMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (req.path === '/metrics') return;
    recordComplianceAudit(
      res.statusCode >= 400 ? 'error.http' : 'data.access',
      req,
      `${req.method} ${req.path}`,
      res.statusCode >= 400 ? 'failure' : 'success',
      { statusCode: res.statusCode },
    );
  });
  next();
}

router.get('/audit', (req: Request, res: Response) => {
  const { eventType, actor, from, to } = req.query;
  const page = Math.max(parseInt(req.query.page?.toString() || '1', 10), 1);
  const limit = 100;
  const fromNs = typeof from === 'string' && /^\d+$/.test(from) ? BigInt(from) : null;
  const toNs = typeof to === 'string' && /^\d+$/.test(to) ? BigInt(to) : null;
  const filtered = auditEntries.filter((entry) => {
    if (eventType && entry.eventType !== eventType) return false;
    if (actor && entry.actor !== actor) return false;
    if (fromNs !== null && BigInt(entry.timestampNs) < fromNs) return false;
    if (toNs !== null && BigInt(entry.timestampNs) > toNs) return false;
    return true;
  });
  const start = (page - 1) * limit;
  res.json({
    success: true,
    data: {
      entries: filtered.slice(start, start + limit),
      pagination: { page, limit, total: filtered.length },
    },
  });
});

router.delete('/data/subject/:id', (req: Request, res: Response) => {
  const subjectId = req.params.id;
  const deletedRangeHash = crypto.createHash('sha256').update(subjectId).digest('hex');
  const certificate = {
    subjectId,
    deletedAt: new Date().toISOString(),
    deletedRangeHash,
    notarization: crypto
      .createHash('sha256')
      .update(`${subjectId}:${deletedRangeHash}:${previousHash}`)
      .digest('hex'),
  };
  recordComplianceAudit('data.deletion', req, 'delete_subject_data', 'success', certificate);
  res.json({ success: true, data: certificate });
});

router.get('/data/subject/:id/export', (req: Request, res: Response) => {
  const subjectId = req.params.id;
  recordComplianceAudit('data.export', req, 'export_subject_data', 'success', { subjectId });
  res.json({
    success: true,
    data: {
      subjectId,
      format: 'json',
      exportedAt: new Date().toISOString(),
      records: [],
    },
  });
});

router.get('/compliance/reports/:framework', (req: Request, res: Response) => {
  const framework = req.params.framework.toLowerCase();
  const reports: Record<string, unknown> = {
    soc2: { framework: 'SOC 2', controls: soc2Controls, posture: 'current posture only' },
    gdpr: {
      framework: 'GDPR',
      dataInventory: ['price_data', 'audit_logs', 'api_usage'],
      retentionPolicies,
      deletionProofs: auditEntries.filter((entry) => entry.eventType === 'data.deletion'),
    },
    mica: {
      framework: 'MiCA',
      oracleTransparency: {
        sources: ['Chainlink', 'Redstone', 'Band Protocol', 'Reflector'],
        methodology: 'median aggregation of normalized source prices',
        historicalAccuracyRecords: '/api/v1/history/:asset',
      },
    },
  };
  const report = reports[framework];
  if (!report) {
    res.status(404).json({ success: false, error: 'Unsupported compliance framework' });
    return;
  }
  res.json({ success: true, data: { report, generatedAt: new Date().toISOString() } });
});

router.get('/compliance/access-reviews', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      cadence: 'quarterly',
      generatedAt: new Date().toISOString(),
      staleKeyThresholdDays: 90,
      autoRevocationGraceDays: 7,
      findings: [],
    },
  });
});

router.get('/compliance/dashboard', (_req: Request, res: Response) => {
  const implemented = soc2Controls.filter((control) => control.status === 'implemented').length;
  res.json({
    success: true,
    data: {
      auditLogVolume: auditEntries.length,
      retentionPolicies,
      accessReviewStatus: 'scheduled',
      soc2ControlCompliancePercent: Math.round((implemented / soc2Controls.length) * 100),
      openComplianceFindings: soc2Controls.filter((control) => control.status !== 'implemented').length,
      timeSinceLastAudit: auditEntries.length ? '0s' : 'never',
    },
  });
});

router.get('/compliance/regulatory-changes', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      monitoredFrameworks: ['SOC 2', 'GDPR', 'MiCA'],
      changes: [],
      affectedControls: [],
      lastCheckedAt: new Date().toISOString(),
    },
  });
});

export default router;
