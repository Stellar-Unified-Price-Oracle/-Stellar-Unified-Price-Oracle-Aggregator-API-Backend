import { Router, Request, Response } from 'express';
import { apiKeyManager, TIER_RATE_LIMITS, KeyTier } from '../services/api-key-manager';
import { corsManager } from '../services/cors-manager';
import { adminAuthMiddleware } from '../middleware/auth';
import { requireRole, ROLES, ROLE_PERMISSIONS } from '../middleware/rbac';
import { logger } from '../middleware/logger';
import { auditLog } from '../services/audit-logger';
import { getDb, isDbAvailable } from '../services/database';
import { ArchivalService } from '../services/archival';
import { DbHealthMonitor } from '../services/db-health-monitor';
import { DataConsistencyChecker } from '../services/data-consistency';
import { BackupService } from '../services/backup';
import { config } from '../config';
import type { Role } from '../middleware/rbac';

const router = Router();
const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

// ── API Key Management ────────────────────────────────────────────────────────

router.post('/keys', (req: Request, res: Response) => {
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

  const limit = typeof rateLimitPerMin === 'number' && rateLimitPerMin >= 1
    ? rateLimitPerMin
    : TIER_RATE_LIMITS[tier as KeyTier];

  try {
    const newKey = apiKeyManager.generateKey(limit, description, tier as KeyTier, role as Role);
    logger.info(`Admin ${req.apiKey?.substring(0, 8)}... generated API key tier=${tier} role=${role}`);

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
    logger.error('Failed to generate API key', err);
    res.status(500).json({
      success: false,
      error: { code: 'KEY_GENERATION_FAILED', message: 'Failed to generate API key' },
    });
  }
});

router.get('/keys', (_req: Request, res: Response) => {
  const keys = apiKeyManager.getAllKeys();
  res.json({ success: true, data: { count: keys.length, keys } });
});

router.get('/keys/:keyHash', (req: Request, res: Response) => {
  const keyInfo = apiKeyManager.findByHash(req.params.keyHash);
  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }
  const { key: _key, ...safeInfo } = keyInfo;
  res.json({ success: true, data: safeInfo });
});

router.post('/keys/:keyHash/rotate', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  const rotated = apiKeyManager.rotateKey(existing.key);
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
});

router.put('/keys/:keyHash/tier', (req: Request, res: Response) => {
  const { tier } = req.body;
  const validTiers: KeyTier[] = ['free', 'pro', 'enterprise', 'admin'];

  if (!validTiers.includes(tier)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TIER', message: `tier must be one of: ${validTiers.join(', ')}` },
    });
  }

  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.updateTier(existing.key, tier as KeyTier);
  res.json({
    success: true,
    data: { keyHash: req.params.keyHash, tier, rateLimitPerMin: TIER_RATE_LIMITS[tier as KeyTier] },
  });
});

router.put('/keys/:keyHash/rate-limit', (req: Request, res: Response) => {
  const { rateLimitPerMin } = req.body;

  if (typeof rateLimitPerMin !== 'number' || rateLimitPerMin < 1) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_RATE_LIMIT', message: 'rateLimitPerMin must be a positive number' },
    });
  }

  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.updateRateLimit(existing.key, rateLimitPerMin);
  res.json({ success: true, data: { keyHash: req.params.keyHash, rateLimitPerMin } });
});

router.post('/keys/:keyHash/revoke', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.revokeKey(existing.key);
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... revoked key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'revoked' } });
});

router.post('/keys/:keyHash/reactivate', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.reactivateKey(existing.key);
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... reactivated key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'reactivated' } });
});

router.delete('/keys/:keyHash', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.deleteKey(existing.key);
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... deleted key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'deleted' } });
});

// ── CORS Management ───────────────────────────────────────────────────────────

router.get('/cors/origins', (_req: Request, res: Response) => {
  res.json({ success: true, data: { origins: corsManager.listOrigins() } });
});

router.post('/cors/origins', (req: Request, res: Response) => {
  const { origin } = req.body;

  if (!origin || typeof origin !== 'string') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: "'origin' must be a non-empty string (e.g. https://example.com or *.example.com)" },
    });
  }

  const added = corsManager.addOrigin(origin);
  const status = added ? 201 : 200;
  res.status(status).json({
    success: true,
    data: { origin, added, origins: corsManager.listOrigins() },
  });
});

router.delete('/cors/origins', (req: Request, res: Response) => {
  const { origin } = req.body;

  if (!origin || typeof origin !== 'string') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: "'origin' must be a non-empty string" },
    });
  }

  const removed = corsManager.removeOrigin(origin);
  if (!removed) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORIGIN_NOT_FOUND', message: `Origin '${origin}' not found in whitelist` },
    });
  }

  res.json({ success: true, data: { origin, removed: true, origins: corsManager.listOrigins() } });
});

// ── Database Pool & Replicas (issues #44, #45) ─────────────────────────────────

router.get('/db/pool', async (_req: Request, res: Response) => {
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

router.post('/archival/run', async (req: Request, res: Response) => {
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

router.post('/archival/restore', async (req: Request, res: Response) => {
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

router.get('/db/health', async (_req: Request, res: Response) => {
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

router.post('/consistency/check', async (_req: Request, res: Response) => {
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

router.post('/backup/run', async (_req: Request, res: Response) => {
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

router.get('/backup/list', (_req: Request, res: Response) => {
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

router.post('/backup/test-restore', async (_req: Request, res: Response) => {
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

router.post('/backup/restore', async (req: Request, res: Response) => {
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

// ── Admin Health ──────────────────────────────────────────────────────────────

router.get('/health', (req: Request, res: Response) => {
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
