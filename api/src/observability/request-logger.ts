import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { pipelineStageLatencyMs } from './metrics';
import { minimizeIp, redactQuery } from '../privacy/telemetryMinimizer';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();

  logger.info(`${req.method} ${req.path}`, {
    requestId: req.requestId,
    traceId: req.traceId,
    spanId: req.spanId,
    query: redactQuery(req.query),
    ip: minimizeIp(req.ip),
  });

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const status = res.statusCode >= 500 ? 'error' : 'ok';
    pipelineStageLatencyMs.observe({ stage: 'api_serve', status }, durationMs);
  });

  next();
}
