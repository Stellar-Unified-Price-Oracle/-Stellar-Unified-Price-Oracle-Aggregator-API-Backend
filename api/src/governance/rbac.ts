import { Request, Response, NextFunction } from 'express';
import { auditLog } from './audit-logger';
import { rbacDeniedTotal } from '../observability/metrics';

export type Role = 'admin' | 'operator' | 'viewer';

export type Permission =
  | 'keys:read'
  | 'keys:write'
  | 'keys:delete'
  | 'keys:rotate'
  | 'roles:write'
  | 'metrics:read'
  | 'cors:read'
  | 'cors:write'
  | 'backup:read'
  | 'backup:write'
  | 'archival:write'
  | 'consistency:write'
  | 'circuit:write'
  | 'system:read'
  | 'dr:read'
  | 'feeds:read'
  | 'feeds:write';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userRole?: Role;
      /** Scopes carried by the presented API key; when present they further
       *  restrict what the role may do (issue #596). */
      apiKeyScopes?: string[];
    }
  }
}

export const ROLES: Role[] = ['admin', 'operator', 'viewer'];

/** Capability catalogue per role. Enforcement is two-part: the role level gate
 *  (`requireRole`) and, for keys that declare scopes, the route permission. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    'keys:read', 'keys:write', 'keys:delete', 'keys:rotate', 'roles:write', 'metrics:read',
    'cors:read', 'cors:write', 'backup:read', 'backup:write', 'archival:write',
    'consistency:write', 'circuit:write', 'system:read', 'dr:read',
    'feeds:read', 'feeds:write',
  ],
  operator: [
    'keys:read', 'keys:write', 'keys:rotate', 'metrics:read', 'cors:read',
    'backup:read', 'backup:write', 'archival:write', 'consistency:write', 'circuit:write',
    'system:read', 'dr:read',
    'feeds:read', 'feeds:write',
  ],
  viewer: ['keys:read', 'metrics:read', 'cors:read', 'backup:read', 'system:read', 'dr:read', 'feeds:read'],
};

const ROLE_LEVEL: Record<Role, number> = {
  admin: 3,
  operator: 2,
  viewer: 1,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLES.includes(value as Role);
}

export function roleLevel(role: Role): number {
  return ROLE_LEVEL[role] ?? 0;
}

export type DenialReason = 'unknown_role' | 'insufficient_role' | 'scope_denied' | 'role_escalation';

export interface AuthzDenial {
  timestamp: number;
  reason: DenialReason;
  role: string;
  route: string;
  keyPrefix: string;
  requiredRole?: Role;
  permission?: Permission;
}

const MAX_RECENT_DENIALS = 100;
const recentDenials: AuthzDenial[] = [];

/** Most recent authorization denials, for diagnostics and tests. */
export function getRecentAuthzDenials(): AuthzDenial[] {
  return [...recentDenials];
}

export function clearAuthzDenials(): void {
  recentDenials.length = 0;
}

function routeOf(req: Request): string {
  return `${req.method} ${req.originalUrl?.split('?')[0] || req.path}`;
}

/** Shared rejection path: 403 response, audit entry and metric. */
export function denyAuthorization(
  req: Request,
  res: Response,
  reason: DenialReason,
  message: string,
  extra: { requiredRole?: Role; permission?: Permission } = {},
): void {
  const role = req.userRole ?? 'unknown';
  const route = routeOf(req);
  const keyPrefix = req.apiKey ? req.apiKey.substring(0, 8) : 'unknown';

  const denial: AuthzDenial = {
    timestamp: Date.now(),
    reason,
    role,
    route,
    keyPrefix,
    ...(extra.requiredRole && { requiredRole: extra.requiredRole }),
    ...(extra.permission && { permission: extra.permission }),
  };
  recentDenials.push(denial);
  if (recentDenials.length > MAX_RECENT_DENIALS) recentDenials.shift();

  auditLog('authz.denied', {
    ip: req.ip,
    userAgent: req.headers?.['user-agent'],
    apiKeyPrefix: keyPrefix,
    details: { reason, role, route, ...extra },
  });
  rbacDeniedTotal.inc({ role, route, reason });

  const code = reason === 'unknown_role' ? 'UNKNOWN_ROLE' : reason === 'scope_denied' ? 'SCOPE_DENIED' : 'FORBIDDEN';
  res.status(403).json({
    success: false,
    error: { code, message },
  });
}

export interface RoleGuardAttributes {
  minRole: Role;
  permission?: Permission;
}

/**
 * Per-route authorization (issue #596). Rejects unknown roles outright,
 * enforces the minimum role level, and — when the presented key declares
 * scopes — requires the route's permission to be one of them.
 *
 * The returned middleware carries `minRole`/`permission` properties so tests
 * can enumerate the admin router and verify every route declares them.
 */
export function requireRole(minRole: Role, permission?: Permission) {
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const role = req.userRole;

    if (!isRole(role)) {
      denyAuthorization(req, res, 'unknown_role', 'API key has an unknown role and cannot be authorized', {
        requiredRole: minRole,
        ...(permission && { permission }),
      });
      return;
    }

    if (ROLE_LEVEL[role] < ROLE_LEVEL[minRole]) {
      denyAuthorization(
        req,
        res,
        'insufficient_role',
        `This operation requires '${minRole}' role or higher`,
        { requiredRole: minRole, ...(permission && { permission }) },
      );
      return;
    }

    if (permission && req.apiKeyScopes && req.apiKeyScopes.length > 0 && !req.apiKeyScopes.includes(permission)) {
      denyAuthorization(
        req,
        res,
        'scope_denied',
        `API key scopes do not include '${permission}'`,
        { requiredRole: minRole, permission },
      );
      return;
    }

    next();
  };

  return Object.assign(guard, { minRole, permission } as RoleGuardAttributes);
}
