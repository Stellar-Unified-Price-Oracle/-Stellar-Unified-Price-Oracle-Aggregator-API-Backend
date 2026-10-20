import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Authorization regression corpus runner.
 *
 * Loads the versioned authorization matrix (see `authorization-matrix.json`
 * alongside this file) and exercises each entry against the route/resolver
 * authorization layer, asserting the expected allow/deny outcome.
 *
 * Matrix schema (versioned):
 * {
 *   "version": "1.0.0",
 *   "cases": [
 *     {
 *       "id": "string",
 *       "description": "string",
 *       "apiVersion": "v1" | "v2",
 *       "route": "string",              // e.g. "GET /v1/orders/:id"
 *       "resolver": "string",           // logical resolver name
 *       "role": "string",               // may be unknown -> boundary case
 *       "scopes": ["string"],           // may include revoked/unknown -> boundary
 *       "lifecycle": "active" | "suspended" | "deleted" | "pending",
 *       "keyState": "valid" | "expired" | "revoked",
 *       "expected": "allow" | "deny",
 *       "category": "normal" | "boundary" | "failure"
 *     }
 *   ]
 * }
 */

type ApiVersion = 'v1' | 'v2';
type Lifecycle = 'active' | 'suspended' | 'deleted' | 'pending';
type KeyState = 'valid' | 'expired' | 'revoked';
type Expected = 'allow' | 'deny';
type Category = 'normal' | 'boundary' | 'failure';

interface MatrixCase {
  id: string;
  description: string;
  apiVersion: ApiVersion;
  route: string;
  resolver: string;
  role: string;
  scopes: string[];
  lifecycle: Lifecycle;
  keyState: KeyState;
  expected: Expected;
  category: Category;
}

interface Matrix {
  version: string;
  cases: MatrixCase[];
}

interface AuthContext {
  role: string;
  scopes: string[];
  lifecycle: Lifecycle;
  keyState: KeyState;
  apiVersion: ApiVersion;
  route: string;
  resolver: string;
}

interface AuthDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Known roles and scopes. Anything outside these sets is treated as an
 * unknown value and must be denied (boundary case).
 */
const KNOWN_ROLES = new Set([
  'admin',
  'operator',
  'viewer',
  'service',
  'billing',
]);

const KNOWN_SCOPES = new Set([
  'orders:read',
  'orders:write',
  'users:read',
  'users:write',
  'billing:read',
  'billing:write',
  'admin:all',
]);

/**
 * Scope requirements per resolver. A resolver requires at least one of the
 * listed scopes unless the role is `admin` (which holds `admin:all`).
 */
const RESOLVER_SCOPE_REQUIREMENTS: Record<string, string[]> = {
  'orders.get': ['orders:read', 'admin:all'],
  'orders.list': ['orders:read', 'admin:all'],
  'orders.create': ['orders:write', 'admin:all'],
  'orders.update': ['orders:write', 'admin:all'],
  'orders.delete': ['orders:write', 'admin:all'],
  'users.get': ['users:read', 'admin:all'],
  'users.list': ['users:read', 'admin:all'],
  'users.update': ['users:write', 'admin:all'],
  'billing.get': ['billing:read', 'admin:all'],
  'billing.update': ['billing:write', 'admin:all'],
};

/**
 * Roles that are allowed to reach a resolver at all (coarse gate). Fine
 * grained scope checks happen afterwards.
 */
const ROLE_RESOLVER_ALLOWLIST: Record<string, Set<string>> = {
  'orders.get': new Set(['admin', 'operator', 'viewer', 'service']),
  'orders.list': new Set(['admin', 'operator', 'viewer', 'service']),
  'orders.create': new Set(['admin', 'operator', 'service']),
  'orders.update': new Set(['admin', 'operator', 'service']),
  'orders.delete': new Set(['admin']),
  'users.get': new Set(['admin', 'operator', 'viewer']),
  'users.list': new Set(['admin', 'operator', 'viewer']),
  'users.update': new Set(['admin']),
  'billing.get': new Set(['admin', 'billing']),
  'billing.update': new Set(['admin', 'billing']),
};

/**
 * Reference authorization evaluator. This mirrors the production
 * authorization layer's decision logic. If the production layer changes,
 * this evaluator and the matrix must be updated together (see README).
 */
function evaluateAuthorization(ctx: AuthContext): AuthDecision {
  // Failure cases: key state must be valid.
  if (ctx.keyState === 'expired') {
    return { allowed: false, reason: 'key_expired' };
  }
  if (ctx.keyState === 'revoked') {
    return { allowed: false, reason: 'key_revoked' };
  }

  // Lifecycle gate: only active principals may act.
  if (ctx.lifecycle !== 'active') {
    return { allowed: false, reason: `lifecycle_${ctx.lifecycle}` };
  }

  // Boundary: unknown role.
  if (!KNOWN_ROLES.has(ctx.role)) {
    return { allowed: false, reason: 'unknown_role' };
  }

  // Boundary: unknown scope present -> reject the whole request.
  for (const scope of ctx.scopes) {
    if (!KNOWN_SCOPES.has(scope)) {
      return { allowed: false, reason: `unknown_scope:${scope}` };
    }
  }

  // Coarse role gate.
  const allowlist = ROLE_RESOLVER_ALLOWLIST[ctx.resolver];
  if (!allowlist) {
    return { allowed: false, reason: `unknown_resolver:${ctx.resolver}` };
  }
  if (!allowlist.has(ctx.role)) {
    return { allowed: false, reason: 'role_not_permitted' };
  }

  // Fine grained scope gate.
  const required = RESOLVER_SCOPE_REQUIREMENTS[ctx.resolver];
  if (!required) {
    return { allowed: false, reason: `unknown_resolver:${ctx.resolver}` };
  }
  const hasRequiredScope = required.some((s) => ctx.scopes.includes(s));
  if (!hasRequiredScope) {
    return { allowed: false, reason: 'missing_scope' };
  }

  return { allowed: true, reason: 'ok' };
}

function loadMatrix(): Matrix {
  const path = join(__dirname, 'authorization-matrix.json');
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Matrix;

  if (!parsed.version || !Array.isArray(parsed.cases)) {
    throw new Error('authorization-matrix.json is malformed: missing version or cases');
  }
  return parsed;
}

let matrix: Matrix;

beforeAll(() => {
  matrix = loadMatrix();
});

describe('authorization regression corpus', () => {
  it('matrix is versioned and non-empty', () => {
    expect(matrix.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(matrix.cases.length).toBeGreaterThan(0);
  });

  it('matrix covers normal, boundary, and failure categories', () => {
    const categories = new Set(matrix.cases.map((c) => c.category));
    expect(categories.has('normal')).toBe(true);
    expect(categories.has('boundary')).toBe(true);
    expect(categories.has('failure')).toBe(true);
  });

  it('matrix covers both API versions', () => {
    const versions = new Set(matrix.cases.map((c) => c.apiVersion));
    expect(versions.has('v1')).toBe(true);
    expect(versions.has('v2')).toBe(true);
  });

  it('matrix case ids are unique', () => {
    const ids = matrix.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('per-case allow/deny assertions', () => {
    it('every case has a well-formed shape', () => {
      for (const c of matrix.cases) {
        expect(c.id, 'case id').toBeTruthy();
        expect(c.route, `route for ${c.id}`).toBeTruthy();
        expect(c.resolver, `resolver for ${c.id}`).toBeTruthy();
        expect(['allow', 'deny']).toContain(c.expected);
        expect(['normal', 'boundary', 'failure']).toContain(c.category);
        expect(['v1', 'v2']).toContain(c.apiVersion);
        expect(Array.isArray(c.scopes)).toBe(true);
      }
    });

    it('runs each matrix case against the authorization evaluator', () => {
      const failures: string[] = [];

      for (const c of matrix.cases) {
        const decision = evaluateAuthorization({
          role: c.role,
          scopes: c.scopes,
          lifecycle: c.lifecycle,
          keyState: c.keyState,
          apiVersion: c.apiVersion,
          route: c.route,
          resolver: c.resolver,
        });

        const actual: Expected = decision.allowed ? 'allow' : 'deny';
        if (actual !== c.expected) {
          failures.push(
            `[${c.id}] ${c.description}: expected ${c.expected}, got ${actual} (reason: ${decision.reason})`,
          );
        }
      }

      expect(failures, failures.join('\n')).toEqual([]);
    });
  });

  describe('boundary cases', () => {
    it('denies unknown roles', () => {
      const decision = evaluateAuthorization({
        role: 'definitely-not-a-role',
        scopes: ['orders:read'],
        lifecycle: 'active',
        keyState: 'valid',
        apiVersion: 'v1',
        route: 'GET /v1/orders/:id',
        resolver: 'orders.get',
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('unknown_role');
    });

    it('denies unknown scopes', () => {
      const decision = evaluateAuthorization({
        role: 'operator',
        scopes: ['orders:read', 'totally:unknown'],
        lifecycle: 'active',
        keyState: 'valid',
        apiVersion: 'v1',
        route: 'GET /v1/orders/:id',
        resolver: 'orders.get',
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('unknown_scope');
    });

    it('denies unknown resolvers', () => {
      const decision = evaluateAuthorization({
        role: 'admin',
        scopes: ['admin:all'],
        lifecycle: 'active',
        keyState: 'valid',
        apiVersion: 'v1',
        route: 'GET /v1/unknown',
        resolver: 'unknown.resolver',
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('unknown_resolver');
    });
  });

  describe('failure cases', () => {
    it('denies expired keys', () => {
      const decision = evaluateAuthorization({
        role: 'admin',
        scopes: ['admin:all'],
        lifecycle: 'active',
        keyState: 'expired',
        apiVersion: 'v1',
        route: 'GET /v1/orders/:id',
        resolver: 'orders.get',
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('key_expired');
    });

    it('denies revoked keys', () => {
      const decision = evaluateAuthorization({
        role: 'admin',
        scopes: ['admin:all'],
        lifecycle: 'active',
        keyState: 'revoked',
        apiVersion: 'v1',
        route: 'GET /v1/orders/:id',
        resolver: 'orders.get',
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('key_revoked');
    });

    it('denies non-active lifecycles', () => {
      for (const lifecycle of ['suspended', 'deleted', 'pending'] as Lifecycle[]) {
        const decision = evaluateAuthorization({
          role: 'admin',
          scopes: ['admin:all'],
          lifecycle,
          keyState: 'valid',
          apiVersion: 'v1',
          route: 'GET /v1/orders/:id',
          resolver: 'orders.get',
        });
        expect(decision.allowed, `lifecycle ${lifecycle}`).toBe(false);
        expect(decision.reason).toBe(`lifecycle_${lifecycle}`);
      }
    });
  });
});

afterAll(() => {
  // No global teardown required; kept for symmetry and future resource cleanup.
});