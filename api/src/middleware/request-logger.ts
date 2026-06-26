import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  logger.info(`${req.method} ${req.path}`, {
    requestId: (req as any).requestId,
    traceId: (req as any).traceId,
    spanId: (req as any).spanId,
    query: req.query,
    ip: req.ip,
  });
  next();
}
