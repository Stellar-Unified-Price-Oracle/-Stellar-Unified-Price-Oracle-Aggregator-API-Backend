import crypto from 'crypto';
import winston from 'winston';

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
  | 'key.rotation_completed';

interface AuditEntry {
  event: AuditEvent;
  timestamp: string;
  ip: string;
  userAgent: string;
  apiKeyPrefix: string;
  details?: Record<string, unknown>;
  prevState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  hmac: string;
}

const AUDIT_SECRET = process.env.AUDIT_SECRET || 'default-audit-secret-change-in-prod';

const auditFileLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/audit.log' }),
  ],
});

let lastHmac = '';

function computeHmac(data: Record<string, unknown>): string {
  const payload = JSON.stringify(data) + lastHmac;
  return crypto.createHmac('sha256', AUDIT_SECRET).update(payload).digest('hex');
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
    ...(context.details && { details: context.details }),
    ...(context.prevState && { prevState: context.prevState }),
    ...(context.newState && { newState: context.newState }),
  };

  const hmac = computeHmac(data as Record<string, unknown>);
  lastHmac = hmac;

  const entry: AuditEntry = { ...data, hmac };
  auditFileLogger.info('audit', entry);
}

export const auditRetentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10);
