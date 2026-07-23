import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './infrastructure/config';
import { corsManager } from './governance/cors-manager';
import { logger } from './observability/logger';
import { requestLogger } from './observability/request-logger';
import { requestIdMiddleware } from './observability/request-id';
import { errorHandler, notFoundHandler } from './infrastructure/error';
import { metricsMiddleware, metricsHandler } from './observability/metrics';
import { authMiddleware, optionalAuthMiddleware } from './governance/auth';
import { sanitizeInputs, cspHeaders } from './governance/sanitization';
import { httpsRedirect, hstsHeaders } from './infrastructure/https';
import { compressionMiddleware } from './infrastructure/compression';
import { usageTrackingMiddleware } from './governance/usage-tracking';
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
import adminRoutes from './governance/admin';
import statusRoutes from './observability/status';
import { uptimeTracker } from './observability/uptime-tracker';
import { AppError } from './infrastructure/app-error';
import { ErrorCode } from './infrastructure/catalog';

// Initialize distributed tracing
initializeTracing(config.tracing);

const app = express();

let db: DatabaseClient | null = null;
let archival: ArchivalService | null = null;
let dbHealthMonitor: DbHealthMonitor | null = null;
let consistencyChecker: DataConsistencyChecker | null = null;
let backupService: BackupService | null = null;

async function initializeApp(): Promise<void> {
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
}

const cache = new HybridCache<any>(logger, {
  redisUrl: config.redisUrl,
  fallbackToLru: true,
  priceTtl: config.priceCacheTtl,
  historyTtl: config.historyCacheTtl,
  sourcesTtl: config.sourcesCacheTtl,
  healthTtl: config.healthCacheTtl,
});

initializeCache(cache);
initializeCacheV2(cache);

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
app.use(
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/metrics',
    handler: (req, res) => {
      const error = new AppError(
        ErrorCode.RATE_LIMITED,
        'Too many requests. Please try again later.',
        undefined,
        req.path,
      );
      res.status(error.status).json(error.toResponseObject());
    },
  }),
);

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
app.use('/api/v1', v1DeprecationHeaders, v1Routes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v2', v2Headers, v2Routes);

// Documentation and metrics
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/metrics', metricsHandler);

// Developer portal: API explorer, key management, usage/billing UI
app.use('/portal', express.static(path.join(__dirname, '..', 'public', 'portal')));

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer(): Promise<void> {
  await initializeApp();

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
    wss.stop();
    if (archival) archival.stop();
    if (dbHealthMonitor) dbHealthMonitor.stop();
    if (consistencyChecker) consistencyChecker.stop();
    if (backupService) backupService.stop();
    if (db) {
      db.disconnect().catch((err) => logger.error('Error disconnecting from database', err));
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
      const body = await res.json() as any;
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
