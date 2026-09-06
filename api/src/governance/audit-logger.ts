import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { decryptSecret } from './crypto';

export type AuditEvent =
  | 'auth.success'
  | 'auth.failure'
  | 'auth.rate_limited'
  | 'admin.key_created'
  | 'admin.key_rotated'
  | 'admin.key_deactivated'
  | 'admin.key_deleted'
  | 'admin.key_reactivated'
  | 'admin.rate_limit_updated'
  | 'admin.role_assigned'
  | 'key.rotation_started'
  | 'key.rotation_completed'
  | 'archival.run'
  | 'archival.restore'
  | 'consistency.check'
  | 'backup.run'
  | 'backup.test-restore'
  | 'backup.restore'
  | 'governance.proposal_created'
  | 'governance.vote_cast'
  | 'governance.proposal_queued'
  | 'governance.proposal_executed'
  | 'governance.proposal_cancelled'
  | 'governance.emergency_execute'
  | 'multisig.proposal_created'
  | 'multisig.proposal_approved'
  | 'multisig.proposal_executed';

export interface AuditEntry {
  event: AuditEvent;
  timestamp: string;
  ip: string;
  userAgent: string;
  apiKeyPrefix: string;
  prevHmac?: string;
  details?: Record<string, unknown>;
  prevState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  hmac: string;
}

const AUDIT_SECRET = process.env.AUDIT_SECRET
  ? decryptSecret(process.env.AUDIT_SECRET)
  : 'default-audit-secret-change-in-prod';

const AUDIT_LOG_FILE = path.resolve(process.cwd(), 'logs/audit.log');

const auditFileLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: AUDIT_LOG_FILE }),
  ],
});

let lastHmac = '';

export function computeAuditHmac(
  data: Omit<AuditEntry, 'hmac'>,
  previousHmac = '',
): string {
  const { hmac: _unusedHmac, ...cleanData } = data as Partial<AuditEntry>;
  const payload = JSON.stringify({ ...cleanData, prevHmac: previousHmac });
  return crypto.createHmac('sha256', AUDIT_SECRET).update(payload).digest('hex');
}

export function verifyAuditLogChain(entries: AuditEntry[]): { valid: boolean; firstInvalidIndex: number | null } {
  let previousHmac = '';

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedHmac = computeAuditHmac(
      {
        event: entry.event,
        timestamp: entry.timestamp,
        ip: entry.ip,
        userAgent: entry.userAgent,
        apiKeyPrefix: entry.apiKeyPrefix,
        ...(entry.details && { details: entry.details }),
        ...(entry.prevState && { prevState: entry.prevState }),
        ...(entry.newState && { newState: entry.newState }),
      },
      entry.prevHmac ?? previousHmac,
    );

    if (entry.hmac !== expectedHmac || (entry.prevHmac ?? previousHmac) !== previousHmac) {
      return { valid: false, firstInvalidIndex: index };
    }

    previousHmac = entry.hmac;
  }

  return { valid: true, firstInvalidIndex: null };
}

export function enforceAuditRetention(retentionDays = auditRetentionDays): number {
  try {
    if (!fs.existsSync(AUDIT_LOG_FILE)) return 0;
    const contents = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
    const entries = contents
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditEntry => !!entry)
      .filter((entry) => {
        const timestampMs = new Date(entry.timestamp).getTime();
        if (Number.isNaN(timestampMs)) return true;
        const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        return timestampMs >= cutoffMs;
      });

    const output = entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
    fs.writeFileSync(AUDIT_LOG_FILE, output, 'utf8');
    return entries.length;
  } catch {
    return 0;
  }
}

export function auditLog(
  event: AuditEvent,
  context: {
    ip?: string;
    userAgent?: string;
    apiKeyPrefix?: string;
    details?: Record<string, unknown>;
    prevState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
  },
): void {
  const data: Omit<AuditEntry, 'hmac'> = {
    event,
    timestamp: new Date().toISOString(),
    ip: context.ip || 'unknown',
    userAgent: context.userAgent || 'unknown',
    apiKeyPrefix: context.apiKeyPrefix || 'unknown',
    prevHmac: lastHmac,
    ...(context.details && { details: context.details }),
    ...(context.prevState && { prevState: context.prevState }),
    ...(context.newState && { newState: context.newState }),
  };

  const hmac = computeAuditHmac(data, lastHmac);
  lastHmac = hmac;

  const entry: AuditEntry = { ...data, hmac };
  auditFileLogger.info('audit', entry);
  enforceAuditRetention();
}

export const auditRetentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10);
