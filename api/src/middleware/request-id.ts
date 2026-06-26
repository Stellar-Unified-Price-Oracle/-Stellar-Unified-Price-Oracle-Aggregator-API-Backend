import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.get('x-request-id') || randomUUID();
  const traceId = req.get('x-trace-id') || randomUUID();
  const spanId = randomUUID();
  const parentSpanId = req.get('x-span-id');

  req.requestId = requestId;
  req.traceId = traceId;
  req.spanId = spanId;
  req.parentSpanId = parentSpanId;

  res.setHeader('x-request-id', requestId);
  res.setHeader('x-trace-id', traceId);
  res.setHeader('x-span-id', spanId);

  next();
}
