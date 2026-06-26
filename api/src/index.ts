import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { logger } from './middleware/logger';
import { requestLogger } from './middleware/request-logger';
import { requestIdMiddleware } from './middleware/request-id';
import { errorHandler, notFoundHandler } from './middleware/error';
import { metricsMiddleware, metricsHandler } from './middleware/metrics';
import { initializeTracing } from './services/tracing';
import { PriceWebSocketServer } from './websocket/server';
import { swaggerSpec } from './services/openapi';
import { ErrorCode } from './errors/catalog';
import { AppError } from './errors/app-error';
import v1Routes from './routes/v1';

// Initialize distributed tracing
initializeTracing(config.tracing);

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
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

app.use('/api/v1', v1Routes);
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/metrics', metricsHandler);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info(`REST API listening on port ${config.port}`);
  logger.info(`Swagger docs at http://localhost:${config.port}/api/v1/docs`);
  logger.info(`Metrics at http://localhost:${config.port}/metrics`);
});

const wss = new PriceWebSocketServer(config.wsPort);
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
