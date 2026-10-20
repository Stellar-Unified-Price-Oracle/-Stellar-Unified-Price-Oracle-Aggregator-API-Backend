import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { config } from './infrastructure/config';
import { corsManager } from './governance/cors-manager';
import { logger } from './observability/logger';
import { requestLogger } from './observability/request-logger';
import { requestIdMiddleware } from './observability/request-id';
import { errorHandler, notFoundHandler } from './infrastructure/error';
import { metricsMiddleware, metricsHandler, serviceStartupDurationMs } from './observability/metrics';
import { authMiddleware, optionalAuthMiddleware } from './governance/auth';
import { sanitizeInputs } from './governance/sanitization';
import { httpsRedirect, hstsHeaders } from './infrastructure/https';
import { compressionMiddleware } from './infrastructure/compression';
import { usageTrackingMiddleware } from './governance/usage-tracking';
import { complianceAuditMiddleware } from './governance/compliance';
import { distributedRateLimiter } from './platform/rate-limiter';
import { PriceWebSocketServer } from './infrastructure/server';
import { swaggerSpec } from './infrastructure/openapi';
import v1Routes, { initializeCache } from './price-serving/v1';
import v2Routes, { initializeCacheV2 } from './price-serving/v2';
import { v1DeprecationHeaders, v2Headers } from './price-serving/versioning';
import { HybridCache } from './price-serving/cache';
import { DatabaseClient, setDb } from './infrastructure/database';
import { ArchivalService } from './infrastructure/archival';
import { DbHealthMonitor } from './infrastructure/db-health-monitor';
import { DataConsistencyChecker } from './infrastructure/data-consistency';
import { BackupService } from './infrastructure/backup';
import { setDatabase } from './price-serving/price-store';
import { initializeTracing } from './observability/tracing';
import platformRoutes from './platform/routes';
import adminRoutes from './governance/admin';
import selfServiceRoutes from './governance/self-service';
import statusRoutes from './observability/status';
import sandboxRoutes, { initializeSandboxCache } from './routes/sandbox';
import featureFlagRoutes from './routes/featureFlags';
import eventRoutes from './routes/events';
import governanceRoutes from './governance/proposal-routes';
import { uptimeTracker } from './observability/uptime-tracker';
import { getVaultClient } from '@stellar-oracle/vault-client';
import { apiKeyManager } from './governance/api-key-manager';
import { initializeAuditIntegrity, startAuditChainVerification } from './governance/audit-logger';
import webhooksRoutes from './webhooks/webhooks';
import graphqlRoutes, { initializeGraphqlCache } from './graphql';
import releaseNotesRoutes from './release-notes/router';
import consumerRoutes from './price-serving/consumer';

// Initialize distributed tracing
initializeTracing(config.tracing);

const app = express();

const startupStartedAt = Date.now();
let db: DatabaseClient | null = null;
let archival: ArchivalService | null = null;
let dbHealthMonitor: DbHealthMonitor | null = null;
let consistencyChecker: DataConsistencyChecker | null = null;
let backupService: BackupService | null = null;

async function initializeApp(): Promise<void> {
  // Load API keys from the shared store (issue #591); env keys only seed an
  // empty store, and an unreachable store fails validation closed.
  await apiKeyManager.initialize();
  apiKeyManager.startRefresh();

  // Initialize Vault for API key and webhook secret management
  try {
    const vault = getVaultClient();
    await vault.initialize();

    // API keys: the store is authoritative. Boot loads it, reports
    // environment-seed conflicts, merges, and seeds anything missing; every
    // later mutation is written through before its response is sent.
    try {
      apiKeyManager.setStore({
        load: () => vault.loadApiKeys(),
        save: (keys) => vault.saveApiKeys(keys),
      });
      const keyBoot = await apiKeyManager.hydrate();
      if (keyBoot.conflicts.length > 0) {
        logger.warn(
          `API key store vs environment seed conflicts: ${keyBoot.conflicts
            .map((c) => `${c.keyPrefix} (env ${c.envHash.substring(0, 12)} vs store ${c.storeHash.substring(0, 12)})`)
            .join('; ')}`,
        );
      }
      if (keyBoot.seeded > 0) {
        logger.info(`Seeded ${keyBoot.seeded} API key(s) into the key store (${keyBoot.loaded} loaded)`);
      }
    } catch (keyErr) {
      apiKeyManager.setStore(null);
      logger.warn('API key store unavailable at startup — API keys stay in memory and mutations are not persisted', keyErr);
    }
    logger.info('Vault secrets engine initialized');

    corsManager.setStore({
      load: async () => {
        const data = await vault.readSecret<{ origins?: string[] }>('secret/data/cors/origins');
        if (!data || !Array.isArray(data.origins)) return [];
        return data.origins.filter((o): o is string => typeof o === 'string');
      },
      save: async (origins: string[]) => {
        await vault.writeSecret('secret/data/cors/origins', { origins });
      },
    });
    await corsManager.hydrate();
    const corsRefreshTimer = setInterval(() => {
      corsManager.hydrate().catch((err) => logger.warn('CORS allowlist refresh failed', err));
    }, 30_000);
    corsRefreshTimer.unref();

    setDsarStore({
      load: async (): Promise<DsarRecord[]> => {
        const data = await vault.readSecret<{ requests?: DsarRecord[] }>('secret/data/compliance/dsars');
        if (!data || !Array.isArray(data.requests)) return [];
        return data.requests;
      },
      save: async (records) => {
        await vault.writeSecret('secret/data/compliance/dsars', { requests: records });
      },
    });
    await hydrateDsars();

    const keyRefreshTimer = setInterval(() => {
      apiKeyManager.refreshFromStore().catch((err: unknown) => logger.warn('API key store refresh failed', err));
    }, 30_000);
    keyRefreshTimer.unref();
  } catch (err) {
    logger.warn('Vault not available — using in-memory API key store fallback', err);
  }

  // Fail closed in production when no key source exists (issue #592).
  bootstrapApiKeyStore();

  // Load durable webhook registrations from the shared store (issue #601).
  await webhookService.load();
  webhookService.startRefresh();

  if (config.databaseUrl) {
    try {
      db = new DatabaseClient(config.databaseUrl, logger);
      await db.initialize();
      setDatabase(db);
      setDb(db);

      archival = new ArchivalService(db, logger);
      archival.start();

      // Issue: Database health not monitored — connection exhaustion, slow
      // queries, and replication lag now emit alerts and Prometheus metrics.
      dbHealthMonitor = new DbHealthMonitor(db, logger, config.dbHealth);
      dbHealthMonitor.start();

      // Issue: No data consistency verification across pipeline layers.
      if (config.consistency.enabled) {
        consistencyChecker = new DataConsistencyChecker(
          db,
          config.aggregatorUrl,
          logger,
          config.consistency.checkIntervalMs,
        );
        consistencyChecker.start();
      }

      // Issue: No backup system — daily encrypted backups with restore testing.
      if (config.backup.enabled) {
        backupService = new BackupService(config.databaseUrl, logger, {
          backupDir: config.backup.dir,
          encryptionKeyHex: config.backup.encryptionKeyHex || undefined,
          dailyIntervalMs: config.backup.intervalMs,
        });
        backupService.start();
      }

      logger.info('PostgreSQL database connected');
    } catch (err) {
      logger.warn('Failed to connect to PostgreSQL, falling back to file-based storage', err);
      db = null;
    }
  } else {
    logger.info('DATABASE_URL not configured, using file-based storage');
  }

  startAuditRetentionScheduler();
}

const cache = new HybridCache<unknown>(logger, {
  redisUrl: config.redisUrl,
  fallbackToLru: true,
  priceTtl: config.priceCacheTtl,
  historyTtl: config.historyCacheTtl,
  sourcesTtl: config.sourcesCacheTtl,
  healthTtl: config.healthCacheTtl,
});

initializeCache(cache);
initializeCacheV2(cache);
initializeSandboxCache(cache);
initializeGraphqlCache(cache);

app.use(helmet());
app.use(cors(corsManager.getCorsOptions()));

if (process.env.NODE_ENV === 'production') {
  app.use(httpsRedirect);
  app.use(hstsHeaders);
}

app.use(compressionMiddleware());
app.use(express.json());
app.use(sanitizeInputs);
app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(metricsMiddleware);
app.use(usageTrackingMiddleware);
app.use(complianceAuditMiddleware);
app.use(distributedRateLimiter);

// Apply authentication to price endpoints
app.use('/api/v1/prices', authMiddleware);
app.use('/api/v1/history', authMiddleware);
app.use('/api/v2/prices', authMiddleware);
app.use('/api/v2/history', authMiddleware);

// Optional auth for general info endpoints
app.use('/api/v1/sources', optionalAuthMiddleware);
app.use('/api/v1/health', optionalAuthMiddleware);
app.use('/api/v2/sources', optionalAuthMiddleware);
app.use('/api/v2/health', optionalAuthMiddleware);

// Routes — v1 tagged as deprecated, v2 is current
app.use('/api/v1/webhooks', authMiddleware, webhooksRoutes);
app.use('/api/v1/releases', releaseNotesRoutes);
app.use('/api/v1/keys', selfServiceRoutes);
app.use('/api/v1', v1DeprecationHeaders, v1Routes);
app.use('/api/v1', v1DeprecationHeaders, platformRoutes);
app.use('/api/v1/sandbox', sandboxRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/governance', governanceRoutes);
// Public status page — no authentication required (#66)
app.use('/api/v1/status', statusRoutes);
app.use('/api/v2', v2Headers, v2Routes);
app.use('/api/v1/consumer', consumerRoutes);
app.use('/api/v2/consumer', consumerRoutes);
app.use('/graphql', graphqlRoutes);
app.use('/api/graphql', graphqlRoutes);

// Feature flags — #117
app.use('/api/feature-flags', featureFlagRoutes);

// Event store read-side — #118
app.use('/api/events', eventRoutes);

// Documentation and metrics
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/metrics', metricsHandler);

// Governance dashboard
app.use('/portal/governance', express.static(path.join(__dirname, '..', 'public', 'governance')));

// Developer portal: API explorer, key management, usage/billing UI
app.use('/portal', express.static(path.join(__dirname, '..', 'public', 'portal')));
app.use('/docs/marketplace', express.static(path.join(__dirname, '..', '..', 'docs', 'marketplace')));
app.use('/.well-known', express.static(path.join(__dirname, '..', 'public', '.well-known')));

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer(): Promise<void> {
  await initializeApp();

  initializeAuditIntegrity();
  startAuditChainVerification();

  const startupDurationMs = Date.now() - startupStartedAt;
  serviceStartupDurationMs.set({ service: 'api' }, startupDurationMs);
  logger.info(`API startup complete in ${startupDurationMs}ms`);

  const server = app.listen(config.port, () => {
    logger.info(`REST API listening on port ${config.port}`);
    logger.info(`Swagger docs at http://localhost:${config.port}/api/v1/docs`);
    logger.info(`Metrics at http://localhost:${config.port}/metrics`);
    if (cache.isUsingRedis()) {
      logger.info('Redis cache is active');
    } else {
      logger.info('Using LRU cache fallback');
    }
  });

  const wss = new PriceWebSocketServer(config.wsPort);
  wss.setCache(cache);
  wss.start();

  // #66 — Synthetic monitoring probes (run every 60 s)
  startSyntheticProbes(config.port);

  const shutdown = () => {
    logger.info('Shutting down API server...');
    stopAuditRetentionScheduler();
    webhookService.stopRefresh();
    wss.stop();
    if (archival) archival.stop();
    if (dbHealthMonitor) dbHealthMonitor.stop();
    if (consistencyChecker) consistencyChecker.stop();
    if (backupService) backupService.stop();
    if (db) {
      db.disconnect().catch((err: unknown) => logger.error('Error disconnecting from database', err));
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  logger.error('Failed to start API server', err);
  process.exit(1);
});

function startSyntheticProbes(port: number): void {
  const probe = async () => {
    // API liveness
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/health/live`);
      uptimeTracker.recordCheck('API', res.ok);
    } catch {
      uptimeTracker.recordCheck('API', false);
    }

    // API readiness / price feed
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/health/ready`);
      if (res.ok) {
        uptimeTracker.recordCheck('Price Feed', true);
      } else {
        uptimeTracker.setDegraded('Price Feed');
      }
    } catch {
      uptimeTracker.recordCheck('Price Feed', false);
    }

    // WebSocket reachability (TCP connect check via health endpoint)
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/health`);
      const body = await res.json() as { data?: { status?: unknown } };
      const wsStatus = body?.data?.status === 'healthy' ? true : body?.data?.status !== 'unhealthy';
      uptimeTracker.recordCheck('WebSocket', wsStatus);
    } catch {
      uptimeTracker.recordCheck('WebSocket', false);
    }
  };

  // Run once immediately then on interval
  probe().catch(() => {});
  const timer = setInterval(() => probe().catch(() => {}), 60_000);
  timer.unref?.();
}

export { app };