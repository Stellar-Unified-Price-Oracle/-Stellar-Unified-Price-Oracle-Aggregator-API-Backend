import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import { listLineage } from '../platform/lineage';
import { getIncidentDisclosurePolicy } from '../platform/self-healing';

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
  store: string;
}

interface DataSubjectRequest {
  id: string;
  subjectId: string;
  requestType: 'access' | 'erasure' | 'explanation';
  status: 'received' | 'processing' | 'fulfilled' | 'rejected';
  createdAt: string;
  fulfilledAt?: string;
  stores: string[];
  notes?: string[];
  result?: Record<string, unknown>;
}

const router = Router();
const auditEntries: ComplianceAuditEntry[] = [];
const auditLogPath = path.resolve(process.cwd(), 'logs/compliance-audit.jsonl');let previousHash = '0'.repeat(64);

const retentionPolicies: RetentionPolicy[] = [
  { dataType: 'price_data', retentionDays: 2555, action: 'archive', store: 'price_history' },
  { dataType: 'audit_logs', retentionDays: 1095, action: 'archive', store: 'compliance_audit_log' },
  { dataType: 'debug_logs', retentionDays: 90, action: 'delete', store: 'debug_logs' },
  { dataType: 'raw_source_payloads', retentionDays: 90, action: 'archive', store: 'raw_source_payloads' },
];

export const keyCustodyPolicy = {
  policy: 'custody follows a dual-control governance flow with role-specific keys and a timelocked quorum change',
  quorum: {
    approvalThreshold: 2,
    votingWindowHours: 72,
    timelockSeconds: 24 * 60 * 60,
    emergencyTimelockSeconds: 0,
  },
  keyHolders: [
    {
      role: 'Mainnet admin',
      custody: 'HSM/KMS-backed signer with an isolated admin policy',
      authority: 'admin-gated config, source management, and emergency signer rotation',
    },
    {
      role: 'Governance signer',
      custody: 'Independent KMS/HSM key per signer; no shared hardware',
      authority: 'approval and execution of quorum changes and governance proposals',
    },
    {
      role: 'Oracle-source signer',
      custody: 'Source-scoped keys with no admin rights',
      authority: 'price submission for a single upstream source',
    },
  ],
  changeFlow: ['propose', 'review', 'approve', 'timelock', 'execute', 'record'],
};

export function getDataSubjectRequests(subjectId: string): DataSubjectRequest[] {
  return dataSubjectRequests.get(subjectId) || [];
}

function ensureRequestList(subjectId: string): DataSubjectRequest[] {
  if (!dataSubjectRequests.has(subjectId)) {
    dataSubjectRequests.set(subjectId, []);
  }
  return dataSubjectRequests.get(subjectId)!;
}

function createDataSubjectRequest(subjectId: string, requestType: DataSubjectRequest['requestType'], req: Request): DataSubjectRequest {
  const request: DataSubjectRequest = {
    id: crypto.randomUUID(),
    subjectId,
    requestType,
    status: 'received',
    createdAt: new Date().toISOString(),
    stores: retentionPolicies.map((policy) => policy.store),
    notes: [`Created via ${req.method} ${req.originalUrl || req.path}`],
  };
  ensureRequestList(subjectId).push(request);
  return request;
}

const soc2Controls = [
  { id: 'CC6.1', name: 'Logical access', status: 'partial', evidence: ['api-key-manager', 'rbac'] },
  { id: 'CC6.6', name: 'Transmission security', status: 'partial', evidence: ['httpsRedirect', 'hstsHeaders'] },
  { id: 'CC7.2', name: 'Monitoring', status: 'partial', evidence: ['metrics', 'usage-anomalies', 'audit-log'] },
  { id: 'CC7.4', name: 'Incident response', status: 'partial', evidence: ['incident-playbook-required'] },
  { id: 'CC8.1', name: 'Change management', status: 'partial', evidence: ['ci-workflow'] },
  { id: 'A1.2', name: 'Capacity management', status: 'partial', evidence: ['metrics'] },
  { id: 'A1.3', name: 'Backup and recovery', status: 'partial', evidence: ['backup-service'] },
];

interface RecurringReport {
  id: string;
  name: string;
  framework: string;
  cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  nextRunAt: Date;
  lastRunAt?: Date;
}

interface PendingReport {
  id: string;
  reportName: string;
  framework: string;
  generatedAt: Date;
  content: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'submitted';
  reviewNotes?: string;
}

const reportSchedules: RecurringReport[] = [
  { id: 'soc2-weekly', name: 'SOC 2 Weekly Monitoring Report', framework: 'soc2', cadence: 'weekly', nextRunAt: new Date() },
  { id: 'gdpr-monthly', name: 'GDPR Monthly Data Protection Report', framework: 'gdpr', cadence: 'monthly', nextRunAt: new Date() },
  { id: 'mica-quarterly', name: 'MiCA Quarterly Transparency Report', framework: 'mica', cadence: 'quarterly', nextRunAt: new Date() },
];
const pendingReports: PendingReport[] = [];

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
      `\n${req.method} ${req.path}`,
      res.statusCode >= 400 ? 'failure' : 'success',
      { statusCode: res.statusCode },
    );
  });
  next();
}

const cadenceMapReg: Record<RecurringReport['cadence'], number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  quarterly: 91 * 24 * 60 * 60 * 1000,
};

function getCadenceMc(cadence: RecurringReport['cadence']): number {
  return cadenceMapReg[cadence];
}

function generateReportContent(framework: string): Record<string, unknown> {
  const total = auditEntries.length;
  const success = auditEntries.filter(e => e.result === 'success').length;
  const failure = auditEntries.filter(e => e.result === 'failure').length;
  const denied = auditEntries.filter(e => e.result === 'denied').length;
  const base = {
    generatedAt: new Date().toISOString(),
    auditEntries: total,
    results: { success, failure, denied },
  };
  switch (framework) {
    case 'soc2':
      return {
        ...base,
        controls: soc2Controls,
        openFindings: soc2Controls.filter(c => c.status !== 'implemented').length,
        incidentCount: auditEntries.filter(e => e.eventType === 'error.http').length,
      };
    case 'gdpr':
      return {
        ...base,
        dataDeletionProofs: auditEntries.filter(e => e.eventType === 'data.deletion').length,
        dataExportProofs: auditEntries.filter(e => e.eventType === 'data.export').length,
        retentionPolicies,
      };
    case 'mica':
      return {
        ...base,
        oracleSources: ['Chainlink', 'Redstone', 'Band Protocol', 'Reflector'],
        priceDeviationAlerts: auditEntries.filter(e => e.eventType === 'error.http' && e.details?.statusCode === 429).length,
      };
    default:
      return { ...base, framework };
  }
}

function runScheduledReports(): void {
  const now = new Date();
  for (const schedule of reportSchedules) {
    if (schedule.nextRunAt <= now) {
      const content = generateReportContent(schedule.framework);
      const pending: PendingReport = {
        id: crypto.randomUUID(),
        reportName: schedule.name,
        framework: schedule.framework,
        generatedAt: now,
        content: JSON.stringify(content),
        status: 'pending_review',
      };
      pendingReports.push(pending);
      schedule.lastRunAt = now;
      schedule.nextRunAt = new Date(now.getTime() + getCadenceMc(weekly));
    }
  }
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
    if (fromNs !== null && BigInt(entry.timestampNs) < fronNs) return false;
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
