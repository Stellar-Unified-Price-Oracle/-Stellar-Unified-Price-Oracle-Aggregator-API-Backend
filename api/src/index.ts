import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { logger } from './middleware/logger';
import { requestLogger } from './middleware/request-logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { metricsMiddleware, metricsHandler } from './middleware/metrics';
import { PriceWebSocketServer } from './websocket/server';
import { swaggerSpec } from './services/openapi';
import v1Routes, { initializeCache } from './routes/v1';
import { HybridCache } from './services/cache';

const app = express();

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
app.use(cors());
app.use(express.json());
app.use(requestLogger);
app.use(metricsMiddleware);
app.use(
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    },
  }),
);

app.use('/api/v1', v1Routes);
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/metrics', metricsHandler);

app.use(notFoundHandler);
app.use(errorHandler);

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
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info('Shutting down API server...');
  wss.stop();
  server.close(() => process.exit(0));
});

export { app, wss };
