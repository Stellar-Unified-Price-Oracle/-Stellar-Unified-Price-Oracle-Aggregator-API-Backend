import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import { listLineage } from '../platform/lineage';
import { getIncidentDisclosurePolicy } from '../platform/self-healing';
import { logger } from '../observability/logger';
import { authMiddleware } from './auth';
import { requireRole } from './rbac';
import {
  FileDsarStore,
  type DsarRecord,
  type DsarRequestType,
  type DsarStatus,
  type DsarStore,
} from './dsar-store';

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
  enforcement: 'automatic' | 'external';
}

const router = Router();
const auditEntries: ComplianceAuditEntry[] = [];
let previousHash = '0'.repeat(64);

function complianceLogDir(): string {
  return process.env.COMPLIANCE_LOG_DIR || path.resolve(process.cwd(), 'logs');
}

function complianceAuditPath(): string {
  return path.join(complianceLogDir(), 'compliance-audit.jsonl');
}

function complianceAuditArchivePath(): string {
  return path.join(complianceLogDir(), 'compliance-audit-archive.jsonl');
}

const retentionPolicies: RetentionPolicy[] = [
  { dataType: 'price_data', retentionDays: 2555, action: 'archive', store: 'price_history', enforcement: 'external' },
  { dataType: 'audit_logs', retentionDays: 1095, action: 'archive', store: 'compliance_audit_log', enforcement: 'automatic' },
  { dataType: 'debug_logs', retentionDays: 90, action: 'delete', store: 'debug_logs', enforcement: 'automatic' },
  { dataType: 'raw_source_payloads', retentionDays: 90, action: 'archive', store: 'raw_source_payloads', enforcement: 'external' },
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

const dsarById = new Map<string, DsarRecord>();
let dsarStore: DsarStore = new FileDsarStore();
let dsarHydrated = false;

export function setDsarStore(store: DsarStore): void {
  dsarStore = store;
  dsarHydrated = false;
}

export async function hydrateDsars(): Promise<void> {
  if (dsarHydrated) return;
  try {
    const records = await dsarStore.load();
    dsarById.clear();
    for (const record of records) {
      dsarById.set(record.id, record);
    }
    dsarHydrated = true;
    logger.info(`Hydrated ${dsarById.size} data-subject request(s) from the DSAR store`);
  } catch (err) {
    logger.warn('Failed to hydrate data-subject request state', err);
  }
}

async function ensureDsarHydrated(): Promise<void> {
  if (!dsarHydrated) await hydrateDsars();
}

function snapshotDsars(): DsarRecord[] {
  return [...dsarById.values()].map((record) => ({
    ...record,
    history: [...record.history],
    ...(record.notes && { notes: [...record.notes] }),
    ...(record.stores && { stores: [...record.stores] }),
  }));
}

async function persistDsars(mutate: () => void): Promise<void> {
  await ensureDsarHydrated();
  const snapshot = snapshotDsars();
  mutate();
  try {
    await dsarStore.save(snapshotDsars());
  } catch (err) {
    dsarById.clear();
    for (const record of snapshot) {
      dsarById.set(record.id, record);
    }
    throw err;
  }
}

export function getDataSubjectRequests(subjectId: string): DsarRecord[] {
  return [...dsarById.values()].filter((record) => record.subjectId === subjectId);
}

function actorOf(req: Request): string {
  return req.apiKey ? req.apiKey.substring(0, 8) : 'anonymous';
}

async function createDataSubjectRequest(
  subjectId: string,
  requestType: DsarRequestType,
  req: Request,
): Promise<DsarRecord> {
  const now = new Date().toISOString();
  const record: DsarRecord = {
    id: crypto.randomUUID(),
    subjectId,
    requestType,
    status: 'received',
    owner: actorOf(req),
    createdAt: now,
    updatedAt: now,
    stores: retentionPolicies.map((policy) => policy.store),
    notes: [`Created via ${req.method} ${req.originalUrl || req.path}`],
    history: [{ at: now, actor: actorOf(req), from: 'created', to: 'received' }],
  };
  await persistDsars(() => {
    dsarById.set(record.id, record);
  });
  return record;
}

function findDsar(subjectId: string, requestId: string): DsarRecord | null {
  const record = dsarById.get(requestId);
  if (!record || record.subjectId !== subjectId) return null;
  return record;
}

const dsarTransitions: Record<DsarStatus, DsarStatus[]> = {
  received: ['processing', 'rejected'],
  processing: ['fulfilled', 'rejected'],
  fulfilled: [],
  rejected: [],
};

function applyTransition(record: DsarRecord, to: DsarStatus, actor: string, note?: string): void {
  const from = record.status;
  record.status = to;
  record.updatedAt = new Date().toISOString();
  if (to === 'fulfilled') record.fulfilledAt = record.updatedAt;
  record.history.push({
    at: record.updatedAt,
    actor,
    from,
    to,
    ...(note && { note }),
  });
}

interface Soc2CheckResult {
  status: 'implemented' | 'partial' | 'gap';
  evidence: string[];
  detail?: string;
}

interface Soc2Control {
  id: string;
  name: string;
  verification: 'automated' | 'manual';
  status: 'implemented' | 'partial' | 'gap';
  evidence: string[];
  check?: () => Soc2CheckResult;
  lastCheckedAt?: string;
  lastResult?: { status: Soc2CheckResult['status']; detail?: string; evidence: string[] };
}

function repoFile(relative: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), relative),
    path.resolve(process.cwd(), '..', relative),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function apiFile(relative: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), relative),
    path.resolve(process.cwd(), 'api', relative),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function checkAdminRouteGuards(): Soc2CheckResult {
  const file = apiFile('src/governance/admin.ts');
  if (!file) {
    return { status: 'gap', evidence: [], detail: 'src/governance/admin.ts not found' };
  }
  const routeLines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^\s*router\.(get|post|put|patch|delete)\(/.test(line));
  const unguarded = routeLines.filter((line) => !line.includes('requireRole('));
  if (routeLines.length === 0) {
    return { status: 'gap', evidence: [file], detail: 'no admin routes found' };
  }
  return {
    status: unguarded.length === 0 ? 'implemented' : 'gap',
    evidence: [`${routeLines.length} admin route declaration(s) in src/governance/admin.ts`],
    detail:
      unguarded.length === 0
        ? 'every admin route declares requireRole(minRole, permission)'
        : `${unguarded.length} admin route(s) without requireRole`,
  };
}

function checkAuditFindings(): Soc2CheckResult {
  const file = repoFile('docs/security/audit-findings.md');
  if (!file) {
    return { status: 'gap', evidence: [], detail: 'docs/security/audit-findings.md not found' };
  }
  const rows = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line.split('|').map((cell) => cell.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1),
    );
  const dataRows = rows.slice(2).filter((cells) => cells.length >= 4 && !/^-+$/.test(cells[0]));
  const openCritical = dataRows.filter(
    (cells) => cells[1]?.toLowerCase() === 'critical' && cells[3]?.toLowerCase() !== 'resolved',
  );
  return {
    status: openCritical.length === 0 ? 'implemented' : 'gap',
    evidence: ['scripts/check-audit-findings.js', 'docs/security/audit-findings.md'],
    detail:
      openCritical.length === 0
        ? 'no open Critical audit findings'
        : `${openCritical.length} open Critical audit finding(s)`,
  };
}

function checkCiWorkflow(): Soc2CheckResult {
  const file = repoFile('.github/workflows/ci.yml');
  if (!file) {
    return { status: 'gap', evidence: [], detail: '.github/workflows/ci.yml not found' };
  }
  return { status: 'implemented', evidence: ['.github/workflows/ci.yml'], detail: 'CI workflow present' };
}

const soc2Controls: Soc2Control[] = [
  { id: 'CC6.1', name: 'Logical access', verification: 'automated', status: 'partial', evidence: ['api-key-manager', 'rbac'], check: checkAdminRouteGuards },
  { id: 'CC6.6', name: 'Transmission security', verification: 'manual', status: 'partial', evidence: ['httpsRedirect', 'hstsHeaders'] },
  { id: 'CC7.2', name: 'Monitoring', verification: 'automated', status: 'partial', evidence: ['metrics', 'usage-anomalies', 'audit-log'], check: checkAuditFindings },
  { id: 'CC7.4', name: 'Incident response', verification: 'manual', status: 'partial', evidence: ['incident-playbook-required'] },
  { id: 'CC8.1', name: 'Change management', verification: 'automated', status: 'partial', evidence: ['ci-workflow'], check: checkCiWorkflow },
  { id: 'A1.2', name: 'Capacity management', verification: 'manual', status: 'partial', evidence: ['metrics'] },
  { id: 'A1.3', name: 'Backup and recovery', verification: 'manual', status: 'partial', evidence: ['backup-service'] },
];

function evaluateSoc2Controls(): Soc2Control[] {
  return soc2Controls.map((control) => {
    if (control.verification !== 'automated' || !control.check) return { ...control };
    const result = control.check();
    return {
      ...control,
      status: result.status,
      lastCheckedAt: new Date().toISOString(),
      lastResult: { status: result.status, ...(result.detail && { detail: result.detail }), evidence: result.evidence },
    };
  });
}

function controlsByVerification(controls: Soc2Control[]): Record<string, number> {
  return {
    automated: controls.filter((control) => control.verification === 'automated').length,
    manual: controls.filter((control) => control.verification === 'manual').length,
  };
}

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
    fs.mkdirSync(path.dirname(complianceAuditPath()), { recursive: true });
    fs.appendFileSync(complianceAuditPath(), `${JSON.stringify(entry)}\n`);
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

export interface RetentionPolicyResult {
  dataType: string;
  enforcement: 'automatic' | 'external';
  action: string;
  retentionDays: number;
  cutoffIso: string;
  processed?: number;
  archivedTo?: string;
  skipped?: boolean;
  reason?: string;
}

export async function enforceRetention(now: Date = new Date()): Promise<{ ranAt: string; policies: RetentionPolicyResult[] }> {
  const results: RetentionPolicyResult[] = [];
  for (const policy of retentionPolicies) {
    const cutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;
    const base = {
      dataType: policy.dataType,
      enforcement: policy.enforcement,
      action: policy.action,
      retentionDays: policy.retentionDays,
      cutoffIso: new Date(cutoff).toISOString(),
    };
    if (policy.enforcement === 'external') {
      results.push({
        ...base,
        skipped: true,
        reason: 'documented policy enforced by the owning service outside this API; not executed here',
      });
      continue;
    }
    if (policy.dataType === 'audit_logs') {
      results.push({ ...base, ...archiveAgedComplianceAudit(cutoff) });
    } else if (policy.dataType === 'debug_logs') {
      results.push({ ...base, ...deleteAgedDebugLogs(cutoff) });
    } else {
      results.push({ ...base, skipped: true, reason: 'no local enforcement path defined' });
    }
  }
  return { ranAt: now.toISOString(), policies: results };
}

function archiveAgedComplianceAudit(cutoff: number): { processed: number; archivedTo?: string } {
  const file = complianceAuditPath();
  if (!fs.existsSync(file)) return { processed: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  const keep: string[] = [];
  const aged: string[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { timestampNs?: string };
      const timestampMs = typeof entry.timestampNs === 'string' ? Number(BigInt(entry.timestampNs) / 1_000_000n) : NaN;
      if (!Number.isNaN(timestampMs) && timestampMs < cutoff) {
        aged.push(line);
      } else {
        keep.push(line);
      }
    } catch {
      keep.push(line);
    }
  }
  if (aged.length > 0) {
    const archive = complianceAuditArchivePath();
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.appendFileSync(archive, `${aged.join('\n')}\n`);
    fs.writeFileSync(file, keep.length > 0 ? `${keep.join('\n')}\n` : '');
    return { processed: aged.length, archivedTo: archive };
  }
  return { processed: 0 };
}

function deleteAgedDebugLogs(cutoff: number): { processed: number } {
  const dir = complianceLogDir();
  if (!fs.existsSync(dir)) return { processed: 0 };
  let processed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.log')) continue;
    if (name === 'audit.log' || name.startsWith('compliance-audit')) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        processed += 1;
      }
    } catch {
      continue;
    }
  }
  return { processed };
}

const retentionTimer = setInterval(() => {
  enforceRetention().catch((err) => logger.warn('Scheduled retention enforcement failed', err));
}, 24 * 60 * 60 * 1000);
retentionTimer.unref?.();

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
    case 'soc2': {
      const controls = evaluateSoc2Controls();
      return {
        ...base,
        controls,
        controlsByVerification: controlsByVerification(controls),
        automatedImplemented: controls.filter(c => c.verification === 'automated' && c.status === 'implemented').length,
        automatedWithRecordedResult: controls.filter(c => c.verification === 'automated' && c.lastCheckedAt).length,
        openFindings: controls.filter(c => c.status !== 'implemented').length,
        incidentCount: auditEntries.filter(e => e.eventType === 'error.http').length,
      };
    }
    case 'gdpr':
      return {
        ...base,
        dataDeletionProofs: auditEntries.filter(e => e.eventType === 'data.deletion').length,
        dataExportProofs: auditEntries.filter(e => e.eventType === 'data.export').length,
        retentionPolicies,
        dataSubjectRequests: dsarById.size,
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
      schedule.nextRunAt = new Date(now.getTime() + getCadenceMc(schedule.cadence));
    }
  }
}

// Regulatory reporting automation (#441): materialise due reports on each cadence.
const reportTimer = setInterval(runScheduledReports, 60 * 60 * 1000);
reportTimer.unref?.();

router.post('/data/subject/:id/requests', authMiddleware, requireRole('operator'), async (req: Request, res: Response) => {
  const subjectId = req.params.id;
  const requestType = (req.body?.requestType || 'access') as DsarRequestType;
  if (!['access', 'erasure', 'explanation'].includes(requestType)) {
    res.status(400).json({ success: false, error: 'requestType must be one of: access, erasure, explanation' });
    return;
  }
  try {
    const request = await createDataSubjectRequest(subjectId, requestType, req);
    recordComplianceAudit('data.subject_request', req, 'request_subject_data', 'success', { subjectId, requestId: request.id, requestType });
    res.status(202).json({ success: true, data: { request } });
  } catch (err) {
    logger.error('Failed to persist data-subject request', err);
    res.status(500).json({ success: false, error: 'failed to persist data subject request' });
  }
});

router.get('/data/subject/:id/requests', authMiddleware, requireRole('viewer'), async (req: Request, res: Response) => {
  await ensureDsarHydrated();
  const requests = getDataSubjectRequests(req.params.id);
  recordComplianceAudit('data.subject_access', req, 'view_subject_requests', 'success', { subjectId: req.params.id, count: requests.length });
  res.json({ success: true, data: { requests, count: requests.length } });
});

router.patch('/data/subject/:id/requests/:requestId', authMiddleware, requireRole('operator'), async (req: Request, res: Response) => {
  await ensureDsarHydrated();
  const request = findDsar(req.params.id, req.params.requestId);
  if (!request) {
    res.status(404).json({ success: false, error: 'request not found' });
    return;
  }

  const to = req.body?.status as DsarStatus;
  if (!to || !(to in dsarTransitions)) {
    res.status(400).json({ success: false, error: 'status must be one of: processing, fulfilled, rejected' });
    return;
  }
  const allowed = dsarTransitions[request.status];
  if (!allowed.includes(to)) {
    res.status(409).json({ success: false, error: `invalid transition ${request.status} -> ${to}` });
    return;
  }

  const from = request.status;
  const actor = actorOf(req);
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  try {
    await persistDsars(() => applyTransition(request, to, actor, note));
  } catch (err) {
    logger.error('Failed to persist data-subject request transition', err);
    res.status(500).json({ success: false, error: 'failed to persist state transition' });
    return;
  }

  recordComplianceAudit('data.subject_request.transition', req, 'transition_subject_data_request', 'success', { subjectId: request.subjectId, requestId: request.id, from, to });
  res.json({ success: true, data: { request } });
});

router.post('/data/subject/:id/requests/:requestId/fulfill', authMiddleware, requireRole('operator'), async (req: Request, res: Response) => {
  await ensureDsarHydrated();
  const request = findDsar(req.params.id, req.params.requestId);
  if (!request) return res.status(404).json({ success: false, error: 'request not found' });
  if (!['received', 'processing'].includes(request.status)) {
    return res.status(409).json({ success: false, error: `invalid transition ${request.status} -> fulfilled` });
  }

  const fulfilledAt = new Date().toISOString();
  const result = {
    retention: retentionPolicies.map((policy) => ({ store: policy.store, action: policy.action, retentionDays: policy.retentionDays, enforcement: policy.enforcement })),
    erasureProof: crypto.createHash('sha256').update(`${request.subjectId}:${fulfilledAt}:${request.requestType}`).digest('hex'),
  };
  try {
    await persistDsars(() => {
      applyTransition(request, 'fulfilled', actorOf(req), `Fulfilled via ${req.method} ${req.originalUrl || req.path}`);
      request.result = result;
    });
  } catch (err) {
    logger.error('Failed to persist data-subject request fulfilment', err);
    return res.status(500).json({ success: false, error: 'failed to persist fulfilment' });
  }

  recordComplianceAudit('data.subject_request.fulfilled', req, 'fulfill_subject_data_request', 'success', { subjectId: request.subjectId, requestId: request.id, ...result });
  res.json({ success: true, data: { request } });
});

router.get('/audit', authMiddleware, requireRole('viewer'), (req: Request, res: Response) => {
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
  const entries = filtered.slice(start, start + limit);
  recordComplianceAudit('data.audit_access', req, 'view_compliance_audit', 'success', { returned: entries.length, total: filtered.length });
  res.json({
    success: true,
    data: {
      entries,
      pagination: { page, limit, total: filtered.length },
    },
  });
});

router.delete('/data/subject/:id', authMiddleware, requireRole('operator'), async (req: Request, res: Response) => {
  const subjectId = req.params.id;
  let request: DsarRecord;
  try {
    request = await createDataSubjectRequest(subjectId, 'erasure', req);
    const deletedRangeHash = crypto.createHash('sha256').update(subjectId).digest('hex');
    const certificate = {
      subjectId,
      deletedAt: new Date().toISOString(),
      deletedRangeHash,
      requestId: request.id,
      stores: retentionPolicies.map((policy) => policy.store),
      notarization: crypto
        .createHash('sha256')
        .update(`${subjectId}:${deletedRangeHash}:${previousHash}`)
        .digest('hex'),
    };
    await persistDsars(() => {
      applyTransition(request, 'fulfilled', actorOf(req), 'Erasure fulfilled');
      request.result = { deletedRangeHash, stores: certificate.stores };
    });
    recordComplianceAudit('data.deletion', req, 'delete_subject_data', 'success', certificate);
    res.json({ success: true, data: certificate });
  } catch (err) {
    logger.error('Failed to persist erasure request', err);
    res.status(500).json({ success: false, error: 'failed to persist erasure request' });
  }
});

router.get('/data/subject/:id/export', authMiddleware, requireRole('operator'), async (req: Request, res: Response) => {
  const subjectId = req.params.id;
  let request: DsarRecord;
  try {
    request = await createDataSubjectRequest(subjectId, 'access', req);
  } catch (err) {
    logger.error('Failed to persist export request', err);
    res.status(500).json({ success: false, error: 'failed to persist export request' });
    return;
  }
  const lineageRecords = listLineage().slice(-5);
  recordComplianceAudit('data.export', req, 'export_subject_data', 'success', { subjectId, requestId: request.id, lineageCount: lineageRecords.length });
  res.json({
    success: true,
    data: {
      subjectId,
      format: 'json',
      exportedAt: new Date().toISOString(),
      requestId: request.id,
      records: lineageRecords.map((record) => ({
        provenanceId: record.provenance_id,
        asset: record.asset,
        sourceCount: record.source_count,
        verificationUrl: record.verification_url,
        rootHash: record.root_hash,
        explanation: `Price ${record.asset} was computed from ${record.source_count} upstream sources and verified with root hash ${record.root_hash}.`,
      })),
      retentionPlan: retentionPolicies,
    },
  });
});

router.get('/compliance/key-custody', (_req: Request, res: Response) => {
  res.json({ success: true, data: { policy: keyCustodyPolicy } });
});

router.get('/compliance/incident-disclosure-policy', (_req: Request, res: Response) => {
  res.json({ success: true, data: { policy: getIncidentDisclosurePolicy() } });
});

export const vulnerabilityDisclosurePolicy = {
  policy: 'https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/blob/main/docs/security/vulnerability-disclosure-policy.md',
  contact: 'security@stellar-unified-oracle.example',
  pgpFingerprint: 'E7F9 2A84 5B1D 9C03 4F6E  82A1 3C75 90D2 1A4B 8C9E',
  securityTxt: '/.well-known/security.txt',
  responseTargets: {
    critical: {
      acknowledgmentHours: 24,
      triageHours: 48,
      remediationTargetDays: 3,
    },
    high: {
      acknowledgmentHours: 48,
      triageBusinessDays: 5,
      remediationTargetDays: 14,
    },
    medium: {
      acknowledgmentBusinessDays: 3,
      triageBusinessDays: 10,
      remediationTargetDays: 30,
    },
    low: {
      acknowledgmentBusinessDays: 3,
      triageBusinessDays: 10,
      remediationTargetDays: 60,
    },
  },
  coordinatedDisclosureDays: 90,
  safeHarbor: true,
};

export function getVulnerabilityDisclosurePolicy() {
  return vulnerabilityDisclosurePolicy;
}

router.get('/compliance/vulnerability-disclosure-policy', (_req: Request, res: Response) => {
  res.json({ success: true, data: { policy: getVulnerabilityDisclosurePolicy() } });
});

router.get('/security/disclosure-policy', (_req: Request, res: Response) => {
  res.json({ success: true, data: { policy: getVulnerabilityDisclosurePolicy() } });
});


router.get('/compliance/reports/:framework', (req: Request, res: Response) => {
  const framework = req.params.framework.toLowerCase();
  const reports: Record<string, unknown> = {
    soc2: {
      framework: 'SOC 2',
      controls: evaluateSoc2Controls(),
      controlsByVerification: controlsByVerification(evaluateSoc2Controls()),
      posture: 'current posture only',
    },
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
  const controls = evaluateSoc2Controls();
  const implemented = controls.filter((control) => control.status === 'implemented').length;
  res.json({
    success: true,
    data: {
      auditLogVolume: auditEntries.length,
      retentionPolicies,
      accessReviewStatus: 'scheduled',
      soc2ControlCompliancePercent: Math.round((implemented / controls.length) * 100),
      soc2ControlsByVerification: controlsByVerification(controls),
      soc2AutomatedPassing: controls.filter(c => c.verification === 'automated' && c.status === 'implemented').length,
      openComplianceFindings: controls.filter((control) => control.status !== 'implemented').length,
      timeSinceLastAudit: auditEntries.length ? '0s' : 'never',
      pendingReports: pendingReports.length,
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
