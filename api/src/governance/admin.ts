import { Router, Request, Response } from 'express';
import {
  apiKeyManager,
  TIER_RATE_LIMITS,
  KeyTier,
  KeyStoreWriteError,
  type GeneratedApiKey,
  normalizePolicyScope,
  type KeyPolicyScope,
} from './api-key-manager';
import { keyMutation } from './key-mutation';
import { clampOverride } from '../platform/limit-model';
import { corsManager } from './cors-manager';
import { recordComplianceAudit } from './compliance';
import { adminAuthMiddleware } from './auth';
import { logger } from '../observability/logger';
import { auditLog } from './audit-logger';
import { getDb, isDbAvailable } from '../infrastructure/database';
import { ArchivalService } from '../infrastructure/archival';
import { DbHealthMonitor } from '../infrastructure/db-health-monitor';
import { DataConsistencyChecker } from '../infrastructure/data-consistency';
import { BackupService } from '../infrastructure/backup';
import { DrStatusService } from '../services/dr-status';
import { config } from '../infrastructure/config';
import { requireRole, roleLevel, denyAuthorization, type Role } from './rbac';
import { eventBus } from '../domain-events';
import { sourceCircuitBreakers } from '../infrastructure/source-circuit-breakers';

const router = Router();
const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

function guardTargetKey(req: Request, res: Response): ReturnType<typeof apiKeyManager.findByHash> {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
    return null;
  }
  const requester = req.userRole ?? 'viewer';
  if (roleLevel(existing.role) > roleLevel(requester)) {
    denyAuthorization(
      req,
      res,
      'role_escalation',
      `A '${requester}' key cannot modify a '${existing.role}' key`,
      { requiredRole: existing.role },
    );
    return null;
  }
  return existing;
}

// ── API Key Management ────────────────────────────────────────────────────────

router.post('/keys', requireRole('operator', 'keys:write'), keyMutation(async (req: Request, res: Response) => {
  const { rateLimitPerMin, description, tier = 'free', role = 'viewer' } = req.body;

  const validTiers: KeyTier[] = ['free', 'pro', 'enterprise', 'admin'];
  const validRoles: Role[] = ['admin', 'operator', 'viewer'];

  if (tier && !validTiers.includes(tier)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TIER', message: `tier must be one of: ${validTiers.join(', ')}` },
    });
  }

  if (role && !validRoles.includes(role)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ROLE', message: `role must be one of: ${validRoles.join(', ')}` },
    });
  }

  const requesterRole = req.userRole ?? 'viewer';
  if (roleLevel(role as Role) > roleLevel(requesterRole)) {
    denyAuthorization(
      req,
      res,
      'role_escalation',
      `A '${requesterRole}' key cannot create a '${role}' key`,
      { requiredRole: role as Role },
    );
    return;
  }

  const limit = typeof rateLimitPerMin === 'number' && rateLimitPerMin >= 1
    ? rateLimitPerMin
    : TIER_RATE_LIMITS[tier as KeyTier];

  try {
    const newKey = await apiKeyManager.transact(() =>
      apiKeyManager.generateKey(limit, description, tier as KeyTier, role as Role),
    );
    logger.info(`Admin ${req.apiKey?.substring(0, 8)}... generated API key tier=${tier} role=${role}`);

    // Publish ApiKeyCreatedEvent
    eventBus.publish({
      type: 'api-key-created',
      payload: {
        keyId: newKey.keyHash,
        ownerId: req.apiKey?.substring(0, 8) || 'anonymous',
      },
      timestamp: Date.now(),
    });

    res.status(201).json({
      success: true,
      data: {
        key: newKey.key,
        keyHash: newKey.keyHash,
        tier: newKey.tier,
        role: newKey.role,
        rateLimitPerMin: newKey.rateLimitPerMin,
        description: newKey.description,
        createdAt: new Date(newKey.createdAt).toISOString(),
        message: 'Store this key securely. It will not be shown again.',
      },
    });
  } catch (err) {
    if (err instanceof KeyStoreWriteError) throw err;
    logger.error('Failed to generate API key', err);
    res.status(500).json({
      success: false,
      error: { code: 'KEY_GENERATION_FAILED', message: 'Failed to generate API key' },
    });
  }
}));

router.get('/keys', requireRole('viewer', 'keys:read'), (_req: Request, res: Response) => {
  const keys = apiKeyManager.getAllKeys();
  res.json({ success: true, data: { count: keys.length, keys } });
});

router.get('/keys/:keyHash', requireRole('viewer', 'keys:read'), (req: Request, res: Response) => {
  const keyInfo = apiKeyManager.findByHash(req.params.keyHash);
  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }
  res.json({ success: true, data: keyInfo });
});

router.post('/keys/:keyHash/rotate', requireRole('operator', 'keys:rotate'), keyMutation(async (req: Request, res: Response) => {
  const existing = guardTargetKey(req, res);
  if (!existing) return;

  const rotated: GeneratedApiKey | null = await apiKeyManager.transact(() => apiKeyManager.rotateKey(req.params.keyHash));
  if (!rotated) {
    return res.status(500).json({
      success: false,
      error: { code: 'ROTATE_FAILED', message: 'Failed to rotate API key' },
    });
  }

  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... rotated key ${req.params.keyHash}`);
  res.json({
    success: true,
    data: {
      key: rotated.key,
      keyHash: rotated.keyHash,
      tier: rotated.tier,
      role: rotated.role,
      rateLimitPerMin: rotated.rateLimitPerMin,
      message: 'Old key is now invalid. Store new key securely.',
    },
  });
}));

router.put('/keys/:keyHash/tier', requireRole('operator', 'keys:write'), keyMutation(async (req: Request, res: Response) => {
  const { tier } = req.body;
  const validTiers: KeyTier[] = ['free', 'pro', 'enterprise', 'admin'];

  if (!validTiers.includes(tier)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TIER', message: `tier must be one of: ${validTiers.join(', ')}` },
    });
  }

  const existing = guardTargetKey(req, res);
  if (!existing) return;

  await apiKeyManager.transact(() => apiKeyManager.updateTier(req.params.keyHash, tier as KeyTier));
  res.json({
    success: true,
    data: { keyHash: req.params.keyHash, tier, rateLimitPerMin: TIER_RATE_LIMITS[tier as KeyTier] },
  });
}));

router.put('/consumer-entitlements/:keyHash', requireRole('operator', 'keys:write'), keyMutation(async (req: Request, res: Response) => {
  const existing = guardTargetKey(req, res);
  if (!existing) return;
  const body = req.body ?? {};
  const effectiveAt = typeof body.effectiveAt === 'string' ? Date.parse(body.effectiveAt) : NaN;
  if (!Number.isFinite(effectiveAt) || !Array.isArray(body.feeds) || body.feeds.length === 0 || body.feeds.length > 100) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ENTITLEMENTS', message: 'effectiveAt must be a valid ISO date and feeds must contain 1 to 100 feed identifiers' } });
  }
  if (body.feeds.some((feed: unknown) => typeof feed !== 'string' || !/^[A-Za-z0-9:_*./-]{1,100}$/.test(feed))) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ENTITLEMENTS', message: 'feeds contains an invalid identifier' } });
  }
  const expiresAt = body.expiresAt === undefined ? undefined : typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= effectiveAt)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ENTITLEMENTS', message: 'expiresAt must be a valid ISO date later than effectiveAt' } });
  }
  if (body.operations !== undefined && (!Array.isArray(body.operations) || body.operations.length === 0 || body.operations.some((item: unknown) => typeof item !== 'string'))) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ENTITLEMENTS', message: 'operations must be a non-empty array of strings' } });
  }
  if (body.environments !== undefined && (!Array.isArray(body.environments) || body.environments.length === 0 || body.environments.some((item: unknown) => typeof item !== 'string'))) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ENTITLEMENTS', message: 'environments must be a non-empty array of strings' } });
  }
  const policy: KeyPolicyScope = {
    feeds: body.feeds as string[],
    operations: body.operations === undefined ? ['read'] : body.operations as string[],
    environments: body.environments === undefined ? ['production'] : body.environments as string[],
    effectiveAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  let normalized: KeyPolicyScope | undefined;
  try { normalized = normalizePolicyScope(policy); } catch {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ENTITLEMENTS', message: 'Entitlement policy is invalid' } });
  }
  await apiKeyManager.transact(() => apiKeyManager.updatePolicy(req.params.keyHash, normalized));
  auditLog('admin.entitlements_updated', {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    apiKeyPrefix: req.apiKey?.substring(0, 8),
    details: { keyPrefix: existing.keyPrefix, effectiveAt: new Date(effectiveAt).toISOString() },
    prevState: { policy: existing.policy ?? null },
    newState: { policy: normalized ?? null },
  });
  return res.json({ success: true, data: { keyPrefix: existing.keyPrefix, effectiveAt: new Date(effectiveAt).toISOString(), policy: normalized ?? null } });
}));

router.put('/keys/:keyHash/rate-limit', requireRole('operator', 'keys:write'), keyMutation(async (req: Request, res: Response) => {
  const { rateLimitPerMin } = req.body;

  if (typeof rateLimitPerMin !== 'number' || rateLimitPerMin < 1) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_RATE_LIMIT', message: 'rateLimitPerMin must be a positive number' },
    });
  }

  const existing = guardTargetKey(req, res);
  if (!existing) return;

  const decision = clampOverride(existing.tier, rateLimitPerMin);
  apiKeyManager.updateRateLimit(req.params.keyHash, decision.effective);
  res.json({
    success: true,
    data: {
      keyHash: req.params.keyHash,
      tier: existing.tier,
      rateLimitPerMin: decision.effective,
      requested: decision.requested,
      ceiling: decision.ceiling,
      clamped: decision.clamped,
    },
  });
}));

router.post('/keys/:keyHash/revoke', requireRole('operator', 'keys:write'), keyMutation(async (req: Request, res: Response) => {
  const existing = guardTargetKey(req, res);
  if (!existing) return;

  await apiKeyManager.transact(() => apiKeyManager.revokeKey(req.params.keyHash));
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... revoked key ${req.params.keyHash}`);

  // Publish ApiKeyRevokedEvent
  eventBus.publish({
    type: 'api-key-revoked',
    payload: {
      keyId: req.params.keyHash,
    },
    timestamp: Date.now(),
  });

  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'revoked' } });
}));

router.post('/keys/:keyHash/reactivate', requireRole('operator', 'keys:write'), keyMutation(async (req: Request, res: Response) => {
  const existing = guardTargetKey(req, res);
  if (!existing) return;

  await apiKeyManager.transact(() => apiKeyManager.reactivateKey(req.params.keyHash));
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... reactivated key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'reactivated' } });
}));

router.delete('/keys/:keyHash', requireRole('admin', 'keys:delete'), keyMutation(async (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  await apiKeyManager.transact(() => apiKeyManager.deleteKey(req.params.keyHash));
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... deleted key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'deleted' } });
}));

// ── CORS Management ───────────────────────────────────────────────────────────

router.get('/cors/origins', requireRole('viewer', 'cors:read'), (_req: Request, res: Response) => {
  res.json({ success: true, data: { origins: corsManager.listOrigins() } });
});

router.post('/cors/origins', requireRole('admin', 'cors:write'), async (req: Request, res: Response) => {
  const { origin } = req.body;

  if (!origin || typeof origin !== 'string') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: "'origin' must be a non-empty string (e.g. https://example.com or *.example.com)" },
    });
  }

  const validation = corsManager.validateOrigin(origin);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: validation.reason },
    });
  }

  const before = corsManager.listOrigins();
  if (before.includes(origin)) {
    return res.status(200).json({
      success: true,
      data: { origin, added: false, origins: before },
    });
  }

  const added = corsManager.addOrigin(origin);
  if (!added) {
    return res.status(500).json({
      success: false,
      error: { code: 'ORIGIN_UPDATE_FAILED', message: 'Failed to add origin to the allowlist' },
    });
  }

  try {
    await corsManager.syncToStore();
  } catch (err) {
    corsManager.restore(before);
    logger.error('Failed to persist CORS allowlist change; rolled back', err);
    return res.status(500).json({
      success: false,
      error: { code: 'STORE_WRITE_FAILED', message: 'Failed to persist allowlist change; change was rolled back' },
    });
  }

  const after = corsManager.listOrigins();
  recordComplianceAudit('cors.allowlist.change', req, 'add_cors_origin', 'success', { origin, before, after });
  eventBus.publish({
    type: 'cors-allowlist-changed',
    payload: { origin, action: 'added', before, after, actor: req.apiKey?.substring(0, 8) || 'unknown' },
    timestamp: Date.now(),
  });

  res.status(201).json({
    success: true,
    data: { origin, added, origins: after },
  });
});

router.delete('/cors/origins', requireRole('admin', 'cors:write'), async (req: Request, res: Response) => {
  const { origin } = req.body;

  if (!origin || typeof origin !== 'string') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: "'origin' must be a non-empty string" },
    });
  }

  const validation = corsManager.validateOrigin(origin);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: validation.reason },
    });
  }

  const before = corsManager.listOrigins();
  const removed = corsManager.removeOrigin(origin);
  if (!removed) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORIGIN_NOT_FOUND', message: `Origin '${origin}' not found in whitelist` },
    });
  }

  try {
    await corsManager.syncToStore();
  } catch (err) {
    corsManager.restore(before);
    logger.error('Failed to persist CORS allowlist change; rolled back', err);
    return res.status(500).json({
      success: false,
      error: { code: 'STORE_WRITE_FAILED', message: 'Failed to persist allowlist change; change was rolled back' },
    });
  }

  const after = corsManager.listOrigins();
  recordComplianceAudit('cors.allowlist.change', req, 'remove_cors_origin', 'success', { origin, before, after });
  eventBus.publish({
    type: 'cors-allowlist-changed',
    payload: { origin, action: 'removed', before, after, actor: req.apiKey?.substring(0, 8) || 'unknown' },
    timestamp: Date.now(),
  });

  res.json({ success: true, data: { origin, removed: true, origins: after } });
});

// ── Database Pool & Replicas (issues #44, #45) ─────────────────────────────────

router.get('/db/pool', requireRole('viewer', 'system:read'), async (_req: Request, res: Response) => {
  if (!isDbAvailable()) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  const db = await getDb();
  res.json({ success: true, data: db.getPoolStats() });
});

// ── Data Archival (issue #43) ──────────────────────────────────────────────────

router.post('/archival/run', requireRole('operator', 'archival:write'), async (req: Request, res: Response) => {
  if (!isDbAvailable()) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true';
  try {
    const db = await getDb();
    const archival = new ArchivalService(db, logger);
    const result = await archival.runOnce(dryRun);
    auditLog('archival.run', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { ...result },
    });
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Archival run failed', err);
    res.status(500).json({
      success: false,
      error: { code: 'ARCHIVAL_FAILED', message: 'Failed to run archival' },
    });
  }
});

router.post('/archival/restore', requireRole('admin', 'archival:write'), async (req: Request, res: Response) => {
  if (!isDbAvailable()) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  const file = typeof req.body?.file === 'string' ? req.body.file : undefined;
  try {
    const db = await getDb();
    const archival = new ArchivalService(db, logger);
    const restored = await archival.restore(file);
    auditLog('archival.restore', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { file, restored },
    });
    res.json({ success: true, data: { restored, file: file || 'all' } });
  } catch (err) {
    logger.error('Archival restore failed', err);
    res.status(500).json({
      success: false,
      error: { code: 'RESTORE_FAILED', message: 'Failed to restore archive' },
    });
  }
});

// ── DB Health Monitor (Issue: connection exhaustion / slow queries / lag) ──────

router.get('/db/health', requireRole('viewer', 'system:read'), async (_req: Request, res: Response) => {
  if (!isDbAvailable()) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  try {
    const db = await getDb();
    const monitor = new DbHealthMonitor(db, logger, config.dbHealth);
    const report = await monitor.runCheck();
    const status = report.status === 'critical' ? 503 : report.status === 'degraded' ? 207 : 200;
    res.status(status).json({ success: true, data: report });
  } catch (err) {
    logger.error('DB health check failed', err);
    res.status(500).json({
      success: false,
      error: { code: 'HEALTH_CHECK_FAILED', message: 'Failed to run DB health check' },
    });
  }
});

// ── Data Consistency (Issue: no cross-layer verification) ─────────────────────

router.post('/consistency/check', requireRole('operator', 'consistency:write'), async (_req: Request, res: Response) => {
  if (!isDbAvailable()) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  try {
    const db = await getDb();
    const checker = new DataConsistencyChecker(
      db,
      config.aggregatorUrl,
      logger,
      config.consistency.checkIntervalMs,
    );
    const results = await checker.checkAll();
    const hasViolation = results.some((r) => r.status === 'violation');
    auditLog('consistency.check', { details: { results } });
    res.status(hasViolation ? 207 : 200).json({ success: true, data: { results } });
  } catch (err) {
    logger.error('Consistency check failed', err);
    res.status(500).json({
      success: false,
      error: { code: 'CONSISTENCY_CHECK_FAILED', message: 'Failed to run consistency check' },
    });
  }
});

// ── Backup (Issue: no backup system) ──────────────────────────────────────────

router.post('/backup/run', requireRole('operator', 'backup:write'), async (_req: Request, res: Response) => {
  if (!config.databaseUrl) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  try {
    const svc = new BackupService(config.databaseUrl, logger, {
      backupDir: config.backup.dir,
      encryptionKeyHex: config.backup.encryptionKeyHex || undefined,
    });
    const result = await svc.createBackup();
    auditLog('backup.run', { details: { file: result.file, sizeBytes: result.sizeBytes } });
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Backup run failed', err);
    res.status(500).json({
      success: false,
      error: { code: 'BACKUP_FAILED', message: 'Failed to create backup' },
    });
  }
});

router.get('/backup/list', requireRole('viewer', 'backup:read'), (_req: Request, res: Response) => {
  const svc = new BackupService(config.databaseUrl || '', logger, {
    backupDir: config.backup.dir,
  });
  const backups = svc.listBackups().map((b) => ({
    file: b.file.split('/').pop(),
    sizeBytes: b.sizeBytes,
    createdAt: b.createdAt.toISOString(),
    encrypted: b.encrypted,
  }));
  res.json({ success: true, data: { count: backups.length, backups } });
});

router.post('/backup/test-restore', requireRole('admin', 'backup:write'), async (_req: Request, res: Response) => {
  if (!config.databaseUrl) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  try {
    const svc = new BackupService(config.databaseUrl, logger, {
      backupDir: config.backup.dir,
      encryptionKeyHex: config.backup.encryptionKeyHex || undefined,
    });
    const result = await svc.testRestoreIntegrity();
    auditLog('backup.test-restore', { details: result });
    res.status(result.success ? 200 : 500).json({ success: result.success, data: result });
  } catch (err) {
    logger.error('Backup restore test failed', err);
    res.status(500).json({
      success: false,
      error: { code: 'RESTORE_TEST_FAILED', message: 'Failed to test restore' },
    });
  }
});

router.post('/backup/restore', requireRole('admin', 'backup:write'), async (req: Request, res: Response) => {
  if (!config.databaseUrl) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  const file = typeof req.body?.file === 'string' ? req.body.file : undefined;
  if (!file) {
    return res.status(400).json({
      success: false,
      error: { code: 'MISSING_FILE', message: "'file' (backup filename) is required" },
    });
  }
  try {
    const svc = new BackupService(config.databaseUrl, logger, {
      backupDir: config.backup.dir,
      encryptionKeyHex: config.backup.encryptionKeyHex || undefined,
    });
    const result = await svc.restore(file);
    auditLog('backup.restore', { details: { file, success: result.success } });
    res.status(result.success ? 200 : 500).json({ success: result.success, data: result });
  } catch (err) {
    logger.error('Backup restore failed', err);
    res.status(500).json({
      success: false,
      error: { code: 'RESTORE_FAILED', message: 'Failed to restore backup' },
    });
  }
});

// ── Disaster Recovery (issue #106) ─────────────────────────────────────────────

router.get('/dr/status', requireRole('viewer', 'dr:read'), (_req: Request, res: Response) => {
  if (!config.databaseUrl) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
  }
  const svc = new DrStatusService(config.databaseUrl, logger, {
    backupDir: config.backup.dir,
    rpoTargetSeconds: config.dr.rpoTargetSeconds,
  });
  const status = svc.getStatus();
  res.json({ success: true, data: { ...status, rtoTargetSeconds: config.dr.rtoTargetSeconds } });
});

// ── Circuit Breaker Management (issue #233) ───────────────────────────────────

router.get('/circuit-breakers', requireRole('viewer', 'system:read'), async (_req: Request, res: Response) => {
  try {
    if (isDbAvailable()) {
      const db = await getDb();
      sourceCircuitBreakers.setDatabaseStateProvider(() => db.getPoolStats().primary.circuitState as 'closed' | 'open' | 'half-open');
    }
    const states = sourceCircuitBreakers.statuses();
    res.json({ success: true, data: { states, count: states.length } });
  } catch (err) {
    logger.error('Failed to list circuit breaker states', err);
    res.status(500).json({
      success: false,
      error: { code: 'CIRCUIT_BREAKER_LIST_FAILED', message: 'Failed to list circuit breaker states' },
    });
  }
});

router.post('/circuit-breakers/:source/reset', requireRole('operator', 'circuit:write'), async (req: Request, res: Response) => {
  const { source } = req.params;
  if (!source) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_SOURCE', message: 'A circuit breaker source is required' },
    });
  }

  const reset = sourceCircuitBreakers.reset(source);
  if (!reset) {
    return res.status(404).json({
      success: false,
      error: { code: 'SOURCE_NOT_FOUND', message: `No circuit breaker registered for source '${source}'` },
    });
  }

  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... reset circuit breaker for ${source}`);
  res.json({ success: true, data: { source, status: sourceCircuitBreakers.status(source) } });
});

router.post('/circuit-breakers/reset-all', requireRole('operator', 'circuit:write'), (_req: Request, res: Response) => {
  const resetCount = sourceCircuitBreakers.resetAll();
  logger.info(`Admin ${_req.apiKey?.substring(0, 8)}... reset ${resetCount} circuit breaker(s)`);
  res.json({ success: true, data: { resetCount } });
});

// ── Admin Health ──────────────────────────────────────────────────────────────

router.get('/health', requireRole('viewer', 'system:read'), (req: Request, res: Response) => {
  const tierLimits = TIER_RATE_LIMITS;
  res.json({
    success: true,
    data: {
      status: 'healthy',
      adminAuthenticated: !!req.apiKey,
      role: req.userRole,
      timestamp: Math.floor(Date.now() / 1000),
      tiers: tierLimits,
      corsOriginsCount: corsManager.listOrigins().length,
    },
  });
});

export default router;
