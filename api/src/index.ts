import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { corsManager } from './services/cors-manager';
import { logger } from './middleware/logger';
import { requestLogger } from './middleware/request-logger';
import { requestIdMiddleware } from './middleware/request-id';
import { errorHandler, notFoundHandler } from './middleware/error';
import { metricsMiddleware, metricsHandler } from './middleware/metrics';
import { authMiddleware, optionalAuthMiddleware } from './middleware/auth';
import { sanitizeInputs, cspHeaders } from './middleware/sanitization';
import { PriceWebSocketServer } from './websocket/server';
import { swaggerSpec } from './services/openapi';
import v1Routes, { initializeCache } from './routes/v1';
import { HybridCache } from './services/cache';
import { DatabaseClient, setDb } from './services/database';
import { setDatabase } from './services/price-store';
import { initializeTracing } from './services/tracing';
import adminRoutes from './routes/admin';
import { AppError } from './errors/app-error';
import { ErrorCode } from './errors/catalog';

// Initialize distributed tracing
initializeTracing(config.tracing);

const app = express();

let db: DatabaseClient | null = null;

async function initializeApp(): Promise<void> {
  if (config.databaseUrl) {
    try {
      db = new DatabaseClient(config.databaseUrl, logger);
      await db.initialize();
      setDatabase(db);
      setDb(db);
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

app.use(helmet());
app.use(cors(corsManager.getCorsOptions()));
app.use(express.json());
app.use(sanitizeInputs);
app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(metricsMiddleware);
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

// Optional auth for general info endpoints
app.use('/api/v1/sources', optionalAuthMiddleware);
app.use('/api/v1/health', optionalAuthMiddleware);

// Routes
app.use('/api/v1', v1Routes);
app.use('/api/v1/admin', adminRoutes);

// Documentation and metrics
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/metrics', metricsHandler);

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

  process.on('SIGTERM', () => {
    logger.info('Shutting down API server...');
    wss.stop();
    if (db) {
      db.disconnect().catch((err) => logger.error('Error disconnecting from database', err));
    }
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    logger.info('Shutting down API server...');
    wss.stop();
    if (db) {
      db.disconnect().catch((err) => logger.error('Error disconnecting from database', err));
    }
    server.close(() => process.exit(0));
  });
}

startServer().catch((err) => {
  logger.error('Failed to start API server', err);
  process.exit(1);
});

export { app };
