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
      /** Policy scopes carried by the presented consumer credential (issue #748). */
      apiKeyPolicyScopes?: PolicyScopes | null;
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

export type DenialReason =
  | 'unknown_role'
  | 'insufficient_role'
  | 'scope_denied'
  | 'role_escalation'
  | 'feed_scope_denied'
  | 'operation_scope_denied'
  | 'environment_scope_denied'
  | 'credential_expired';

export interface AuthzDenial {
  timestamp: number;
  reason: DenialReason;
  role: string;
  route: string;
  keyPrefix: string;
  requiredRole?: Role;
  permission?: Permission;
  /** Feed the request targeted, when the denial relates to feed scoping. */
  feed?: string;
  /** Operation the request attempted, when the denial relates to operation scoping. */
  operation?: string;
  /** Environment the request targeted, when the denial relates to environment scoping. */
  environment?: string;
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

/**
 * Policy scopes attached to a consumer credential (issue #748). These are
 * stricter than the legacy `apiKeyScopes` list: they can restrict which feeds,
 * operations and environments a key may touch, and can carry an expiry.
 *
 * A credential with no policy scopes keeps the legacy behaviour (role +
 * optional permission list). A credential with policy scopes is intersected
 * with the role's permissions — it can never widen access.
 */
export interface PolicyScopes {
  /** Permissions the credential may exercise. Intersected with role permissions. */
  permissions?: Permission[];
  /** Feed identifiers the credential may access. Empty/undefined means all feeds. */
  feeds?: string[];
  /** Operations (e.g. 'read', 'write', 'rotate') the credential may perform. */
  operations?: string[];
  /** Environments (e.g. 'production', 'staging') the credential may target. */
  environments?: string[];
  /** Epoch milliseconds after which the credential is rejected. */
  expiresAt?: number;
}

/** Effective permissions for a credential: role permissions narrowed by any
 *  policy-scope permission list. Never widens beyond the role. */
export function effectivePermissions(role: Role, scopes?: PolicyScopes | null): Permission[] {
  const rolePerms = ROLE_PERMISSIONS[role] ?? [];
  if (!scopes || !scopes.permissions || scopes.permissions.length === 0) {
    return [...rolePerms];
  }
  const allowed = new Set(scopes.permissions);
  return rolePerms.filter((p) => allowed.has(p));
}

/** True when the credential's policy scopes have expired. */
export function isCredentialExpired(scopes?: PolicyScopes | null, now: number = Date.now()): boolean {
  return !!scopes && typeof scopes.expiresAt === 'number' && now >= scopes.expiresAt;
}

/** True when `value` is permitted by a scope list; an empty/undefined list means unrestricted. */
function scopeAllows(list: string[] | undefined, value: string | undefined): boolean {
  if (!list || list.length === 0) return true;
  if (value === undefined) return false;
  return list.includes(value);
}

export interface ScopeCheckResult {
  ok: boolean;
  reason?: DenialReason;
  message?: string;
}

/**
 * Evaluate a credential's policy scopes against a requested operation.
 * Returns the first failing constraint so callers can emit a precise denial.
 */
export function checkPolicyScopes(
  scopes: PolicyScopes | null | undefined,
  request: { permission?: Permission; feed?: string; operation?: string; environment?: string },
  now: number = Date.now(),
): ScopeCheckResult {
  if (!scopes) return { ok: true };

  if (isCredentialExpired(scopes, now)) {
    return { ok: false, reason: 'credential_expired', message: 'API key credential has expired' };
  }

  if (request.permission && scopes.permissions && scopes.permissions.length > 0
      && !scopes.permissions.includes(request.permission)) {
    return {
      ok: false,
      reason: 'scope_denied',
      message: `API key scopes do not include '${request.permission}'`,
    };
  }

  if (!scopeAllows(scopes.feeds, request.feed)) {
    return {
      ok: false,
      reason: 'feed_scope_denied',
      message: `API key is not scoped to feed '${request.feed}'`,
    };
  }

  if (!scopeAllows(scopes.operations, request.operation)) {
    return {
      ok: false,
      reason: 'operation_scope_denied',
      message: `API key is not scoped to operation '${request.operation}'`,
    };
  }

  if (!scopeAllows(scopes.environments, request.environment)) {
    return {
      ok: false,
      reason: 'environment_scope_denied',
      message: `API key is not scoped to environment '${request.environment}'`,
    };
  }

  return { ok: true };
}

/** Shared rejection path: 403 response, audit entry and metric. */
export function denyAuthorization(
  req: Request,
  res: Response,
  reason: DenialReason,
  message: string,
  extra: {
    requiredRole?: Role;
    permission?: Permission;
    feed?: string;
    operation?: string;
    environment?: string;
  } = {},
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
    ...(extra.feed && { feed: extra.feed }),
    ...(extra.operation && { operation: extra.operation }),
    ...(extra.environment && { environment: extra.environment }),
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

  const code = reason === 'unknown_role'
    ? 'UNKNOWN_ROLE'
    : reason === 'scope_denied'
      ? 'SCOPE_DENIED'
      : reason === 'credential_expired'
        ? 'CREDENTIAL_EXPIRED'
        : reason === 'feed_scope_denied'
          ? 'FEED_SCOPE_DENIED'
          : reason === 'operation_scope_denied'
            ? 'OPERATION_SCOPE_DENIED'
            : reason === 'environment_scope_denied'
              ? 'ENVIRONMENT_SCOPE_DENIED'
              : 'FORBIDDEN';
  res.status(403).json({
    success: false,
    error: { code, message },
  });
}

export interface RoleGuardAttributes {
  minRole: Role;
  permission?: Permission;
  /** Optional feed/operation/environment constraints enforced against policy scopes. */
  feed?: string;
  operation?: string;
  environment?: string;
}

export interface ScopeGuardOptions {
  feed?: string;
  operation?: string;
  environment?: string;
}

/** Resolve the feed/operation/environment a request targets, preferring explicit
 *  guard options and falling back to request params/query/body. */
function resolveScopeTarget(
  req: Request,
  options: ScopeGuardOptions,
): { feed?: string; operation?: string; environment?: string } {
  const pick = (explicit: string | undefined, ...candidates: unknown[]): string | undefined => {
    if (explicit) return explicit;
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    return undefined;
  };
  return {
    feed: pick(options.feed, req.params?.feed, req.params?.feedId, req.query?.feed, req.body?.feed),
    operation: pick(options.operation, req.params?.operation, req.query?.operation, req.body?.operation),
    environment: pick(options.environment, req.params?.environment, req.query?.environment, req.body?.environment),
  };
}

/**
 * Per-route authorization (issue #596). Rejects unknown roles outright,
 * enforces the minimum role level, and — when the presented key declares
 * scopes — requires the route's permission to be one of them.
 *
 * The returned middleware carries `minRole`/`permission` properties so tests
 * can enumerate the admin router and verify every route declares them.
 */
export function requireRole(minRole: Role, permission?: Permission, options: ScopeGuardOptions = {}) {
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

    const target = resolveScopeTarget(req, options);
    const scopeCheck = checkPolicyScopes(req.apiKeyPolicyScopes, {
      ...(permission && { permission }),
      ...(target.feed && { feed: target.feed }),
      ...(target.operation && { operation: target.operation }),
      ...(target.environment && { environment: target.environment }),
    });
    if (!scopeCheck.ok) {
      denyAuthorization(
        req,
        res,
        scopeCheck.reason ?? 'scope_denied',
        scopeCheck.message ?? 'API key policy scopes deny this operation',
        {
          requiredRole: minRole,
          ...(permission && { permission }),
          ...(target.feed && { feed: target.feed }),
          ...(target.operation && { operation: target.operation }),
          ...(target.environment && { environment: target.environment }),
        },
      );
      return;
    }

    next();
  };

  return Object.assign(guard, { minRole, permission, ...options } as RoleGuardAttributes);
}

/**
 * Guard that only checks policy scopes (no role gate). Useful for routes that
 * already sit behind `requireRole` but need feed/operation/environment scoping.
 */
export function requirePermission(permission: Permission, options: ScopeGuardOptions = {}) {
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const role = req.userRole;
    if (!isRole(role)) {
      denyAuthorization(req, res, 'unknown_role', 'API key has an unknown role and cannot be authorized', {
        permission,
      });
      return;
    }

    const effective = effectivePermissions(role, req.apiKeyPolicyScopes);
    if (!effective.includes(permission)) {
      denyAuthorization(
        req,
        res,
        'scope_denied',
        `API key scopes do not include '${permission}'`,
        { permission },
      );
      return;
    }

    const target = resolveScopeTarget(req, options);
    const scopeCheck = checkPolicyScopes(req.apiKeyPolicyScopes, {
      permission,
      ...(target.feed && { feed: target.feed }),
      ...(target.operation && { operation: target.operation }),
      ...(target.environment && { environment: target.environment }),
    });
    if (!scopeCheck.ok) {
      denyAuthorization(
        req,
        res,
        scopeCheck.reason ?? 'scope_denied',
        scopeCheck.message ?? 'API key policy scopes deny this operation',
        {
          permission,
          ...(target.feed && { feed: target.feed }),
          ...(target.operation && { operation: target.operation }),
          ...(target.environment && { environment: target.environment }),
        },
      );
      return;
    }

    next();
  };

  return Object.assign(guard, { permission, ...options } as { permission: Permission } & ScopeGuardOptions);
}
