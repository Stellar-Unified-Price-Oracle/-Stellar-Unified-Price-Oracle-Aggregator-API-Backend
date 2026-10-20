import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import adminRouter from '../../src/governance/admin';
import { apiKeyManager, type GeneratedApiKey } from '../../src/governance/api-key-manager';
import {
  clearAuthzDenials,
  getRecentAuthzDenials,
  ROLE_PERMISSIONS,
  type Role,
} from '../../src/governance/rbac';
import { rbacDeniedTotal } from '../../src/observability/metrics';

const { auditLogSpy } = vi.hoisted(() => ({ auditLogSpy: vi.fn() }));

vi.mock('../../src/governance/audit-logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/governance/audit-logger')>();
  return { ...actual, auditLog: auditLogSpy };
});

const EXPECTED: Record<string, { role: Role; permission: string }> = {
  'POST /keys': { role: 'operator', permission: 'keys:write' },
  'GET /keys': { role: 'viewer', permission: 'keys:read' },
  'GET /keys/:keyHash': { role: 'viewer', permission: 'keys:read' },
  'POST /keys/:keyHash/rotate': { role: 'operator', permission: 'keys:rotate' },
  'PUT /keys/:keyHash/tier': { role: 'operator', permission: 'keys:write' },
  'PUT /keys/:keyHash/rate-limit': { role: 'operator', permission: 'keys:write' },
  'POST /keys/:keyHash/revoke': { role: 'operator', permission: 'keys:write' },
  'POST /keys/:keyHash/reactivate': { role: 'operator', permission: 'keys:write' },
  'DELETE /keys/:keyHash': { role: 'admin', permission: 'keys:delete' },
  'GET /cors/origins': { role: 'viewer', permission: 'cors:read' },
  'POST /cors/origins': { role: 'admin', permission: 'cors:write' },
  'DELETE /cors/origins': { role: 'admin', permission: 'cors:write' },
  'GET /db/pool': { role: 'viewer', permission: 'system:read' },
  'POST /archival/run': { role: 'operator', permission: 'archival:write' },
  'POST /archival/restore': { role: 'admin', permission: 'archival:write' },
  'GET /db/health': { role: 'viewer', permission: 'system:read' },
  'POST /consistency/check': { role: 'operator', permission: 'consistency:write' },
  'POST /backup/run': { role: 'operator', permission: 'backup:write' },
  'GET /backup/list': { role: 'viewer', permission: 'backup:read' },
  'POST /backup/test-restore': { role: 'admin', permission: 'backup:write' },
  'POST /backup/restore': { role: 'admin', permission: 'backup:write' },
  'GET /dr/status': { role: 'viewer', permission: 'dr:read' },
  'GET /circuit-breakers': { role: 'viewer', permission: 'system:read' },
  'POST /circuit-breakers/:source/reset': { role: 'operator', permission: 'circuit:write' },
  'POST /circuit-breakers/reset-all': { role: 'operator', permission: 'circuit:write' },
  'GET /health': { role: 'viewer', permission: 'system:read' },
};

function collectDeclaredRoutes(): Record<string, { role?: Role; permission?: string }> {
  const declared: Record<string, { role?: Role; permission?: string }> = {};
  for (const layer of adminRouter.stack as unknown as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  }>) {
    if (!layer.route) continue;
    const path = layer.route.path;
    for (const method of Object.keys(layer.route.methods)) {
      const guard = layer.route.stack
        .map((entry) => entry.handle)
        .find((handle): handle is ((...args: unknown[]) => void) & { minRole?: Role; permission?: string } =>
          typeof handle === 'function' && typeof (handle as { minRole?: unknown }).minRole === 'string',
        );
      declared[`${method.toUpperCase()} ${path}`] = guard
        ? { role: guard.minRole, permission: guard.permission }
        : {};
    }
  }
  return declared;
}

describe('admin route role matrix', () => {
  it('declares an explicit role+permission guard on every admin route and nowhere else', () => {
    const declared = collectDeclaredRoutes();
    expect(Object.keys(declared).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [route, expected] of Object.entries(EXPECTED)) {
      expect(declared[route], route).toEqual(expected);
    }
  });

  it('every guarded permission is granted to the minimum role in the permission matrix', () => {
    for (const [route, expected] of Object.entries(EXPECTED)) {
      expect(
        ROLE_PERMISSIONS[expected.role],
        `${route} requires '${expected.permission}' but '${expected.role}' lacks it`,
      ).toContain(expected.permission);
    }
  });
});

describe('admin route authorization behavior', () => {
  let app: express.Express;
  let viewerKey: string;
  let operatorKey: string;
  let adminKey: string;
  let scopedOperatorKey: string;
  let policyScopedOperatorKey: string;
  let policyScopedReadOnlyKey: string;
  let policyScopedExpiredKey: string;
  let policyScopedWrongEnvKey: string;
  let unknownRoleKey: string;
  let victimAdmin: GeneratedApiKey;
  let victimViewer: GeneratedApiKey;

  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

  beforeAll(() => {
    viewerKey = apiKeyManager.generateKey(1000, 'matrix viewer', 'free', 'viewer').key;
    operatorKey = apiKeyManager.generateKey(1000, 'matrix operator', 'free', 'operator').key;
    adminKey = apiKeyManager.generateKey(1000, 'matrix admin', 'admin', 'admin').key;
    scopedOperatorKey = apiKeyManager.generateKey(1000, 'scoped operator', 'free', 'operator', ['keys:read']).key;
    policyScopedOperatorKey = apiKeyManager.generateKey(1000, 'policy operator', 'free', 'operator', {
      policy: {
        scopes: ['keys:read', 'keys:write'],
        environments: ['production'],
        expiresAt: Date.now() + 60_000,
      },
    }).key;
    policyScopedReadOnlyKey = apiKeyManager.generateKey(1000, 'policy read-only', 'free', 'operator', {
      policy: {
        scopes: ['keys:read'],
        environments: ['production'],
        expiresAt: Date.now() + 60_000,
      },
    }).key;
    policyScopedExpiredKey = apiKeyManager.generateKey(1000, 'policy expired', 'free', 'operator', {
      policy: {
        scopes: ['keys:read', 'keys:write'],
        environments: ['production'],
        expiresAt: Date.now() - 1_000,
      },
    }).key;
    policyScopedWrongEnvKey = apiKeyManager.generateKey(1000, 'policy wrong env', 'free', 'operator', {
      policy: {
        scopes: ['keys:read', 'keys:write'],
        environments: ['staging'],
        expiresAt: Date.now() + 60_000,
      },
    }).key;
    unknownRoleKey = apiKeyManager.generateKey(1000, 'unknown role', 'free', 'editor' as Role).key;
    victimAdmin = apiKeyManager.generateKey(1000, 'victim admin', 'admin', 'admin');
    victimViewer = apiKeyManager.generateKey(1000, 'victim viewer', 'free', 'viewer');
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/admin', adminRouter);
    clearAuthzDenials();
    auditLogSpy.mockClear();
  });

  it('allows each role to read', async () => {
    for (const key of [viewerKey, operatorKey, adminKey]) {
      const res = await request(app).get('/admin/keys').set(auth(key));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });

  it('rejects missing or invalid keys with 401', async () => {
    const missing = await request(app).get('/admin/keys');
    expect(missing.status).toBe(401);
    const invalid = await request(app).get('/admin/keys').set(auth('not-a-real-key'));
    expect(invalid.status).toBe(401);
  });

  it('rejects a key with an unknown role with 403 UNKNOWN_ROLE', async () => {
    const res = await request(app).get('/admin/keys').set(auth(unknownRoleKey));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNKNOWN_ROLE');
    expect(getRecentAuthzDenials().some((d) => d.reason === 'unknown_role')).toBe(true);
  });

  it('blocks viewer writes with 403 insufficient_role', async () => {
    const res = await request(app)
      .put(`/admin/keys/${victimViewer.keyHash}/tier`)
      .set(auth(viewerKey))
      .send({ tier: 'pro' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('operator');
  });

  it('blocks viewer key deletion (admin-only route) with 403', async () => {
    const res = await request(app)
      .delete(`/admin/keys/${victimViewer.keyHash}`)
      .set(auth(viewerKey));
    expect(res.status).toBe(403);
  });

  it('blocks operator key deletion with 403 insufficient_role', async () => {
    const res = await request(app)
      .delete(`/admin/keys/${victimViewer.keyHash}`)
      .set(auth(operatorKey));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('admin');
  });

  it('allows operator to create a viewer key but not an admin key (role escalation)', async () => {
    const allowed = await request(app)
      .post('/admin/keys')
      .set(auth(operatorKey))
      .send({ role: 'viewer', tier: 'free' });
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.role).toBe('viewer');

    const denied = await request(app)
      .post('/admin/keys')
      .set(auth(operatorKey))
      .send({ role: 'admin', tier: 'free' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(denied.body.error.message).toContain('cannot create');
  });

  it('rejects an invalid requested role with 400 INVALID_ROLE', async () => {
    const res = await request(app)
      .post('/admin/keys')
      .set(auth(adminKey))
      .send({ role: 'superuser', tier: 'free' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
  });

  it('prevents an operator from rotating an admin key (target escalation)', async () => {
    const res = await request(app)
      .post(`/admin/keys/${victimAdmin.keyHash}/rotate`)
      .set(auth(operatorKey));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('cannot modify');
    expect(victimAdmin.keyHash).toBeTruthy();
  });

  it('allows an operator to revoke a lower-ranked key without escalation', async () => {
    const res = await request(app)
      .post(`/admin/keys/${victimViewer.keyHash}/revoke`)
      .set(auth(operatorKey));
    expect(res.status).toBe(200);
    expect(res.body.data.action).toBe('revoked');
  });

  it('allows an admin to delete a key', async () => {
    const doomed = apiKeyManager.generateKey(1000, 'doomed', 'free', 'viewer');
    const res = await request(app)
      .delete(`/admin/keys/${doomed.keyHash}`)
      .set(auth(adminKey));
    expect(res.status).toBe(200);
    expect(res.body.data.action).toBe('deleted');
  });

  it('enforces scopes: a scoped operator key may read but not write', async () => {
    const read = await request(app).get('/admin/keys').set(auth(scopedOperatorKey));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post('/admin/keys')
      .set(auth(scopedOperatorKey))
      .send({ role: 'viewer', tier: 'free' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('SCOPE_DENIED');
  });

  it('allows a policy-scoped operator key to read and write within its scope', async () => {
    const read = await request(app).get('/admin/keys').set(auth(policyScopedOperatorKey));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post('/admin/keys')
      .set(auth(policyScopedOperatorKey))
      .send({ role: 'viewer', tier: 'free' });
    expect(write.status).toBe(201);
  });

  it('denies a policy-scoped key an operation outside its scopes with SCOPE_DENIED', async () => {
    const res = await request(app)
      .post('/admin/keys')
      .set(auth(policyScopedReadOnlyKey))
      .send({ role: 'viewer', tier: 'free' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCOPE_DENIED');
    expect(getRecentAuthzDenials().some((d) => d.reason === 'scope_denied')).toBe(true);
  });

  it('rejects an expired policy-scoped key with 403 CREDENTIAL_EXPIRED', async () => {
    const res = await request(app).get('/admin/keys').set(auth(policyScopedExpiredKey));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CREDENTIAL_EXPIRED');
  });

  it('rejects a policy-scoped key used in the wrong environment with 403 ENVIRONMENT_DENIED', async () => {
    const res = await request(app).get('/admin/keys').set(auth(policyScopedWrongEnvKey));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ENVIRONMENT_DENIED');
  });

  it('counts, audits, and buffers authorization denials', async () => {
    const incSpy = vi.spyOn(rbacDeniedTotal, 'inc');
    try {
      const res = await request(app)
        .put(`/admin/keys/${victimViewer.keyHash}/tier`)
        .set(auth(viewerKey))
        .send({ tier: 'pro' });
      expect(res.status).toBe(403);

      expect(incSpy).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'viewer', reason: 'insufficient_role' }),
      );
      expect(auditLogSpy).toHaveBeenCalledWith(
        'authz.denied',
        expect.objectContaining({
          details: expect.objectContaining({ reason: 'insufficient_role', role: 'viewer' }),
        }),
      );
      expect(
        getRecentAuthzDenials().some(
          (d) => d.reason === 'insufficient_role' && d.role === 'viewer' && d.permission === 'keys:write',
        ),
      ).toBe(true);
    } finally {
      incSpy.mockRestore();
    }
  });
});
