import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { context, trace } from '@opentelemetry/api';

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

  // Propagate trace context
  const tracer = trace.getTracer('express-middleware');
  const span = tracer.startSpan(`${req.method} ${req.path}`, {
    attributes: {
      'http.method': req.method,
      'http.url': req.url,
      'http.target': req.path,
      'http.host': req.hostname,
      'http.scheme': req.protocol,
      'http.user_agent': req.get('user-agent'),
      'http.client_ip': req.ip,
      'trace.id': traceId,
      'request.id': requestId,
      'span.id': spanId,
    },
  });

  context.with(trace.setSpan(context.active(), span), () => {
    const originalSend = res.send;

    res.send = function (data: unknown) {
      const statusCode = res.statusCode;
      span.setAttributes({
        'http.status_code': statusCode,
      });

      if (statusCode >= 400) {
        span.recordException(new Error(`HTTP ${statusCode}`));
      }

      span.end();
      return originalSend.call(this, data);
    };

    next();
  });
}

