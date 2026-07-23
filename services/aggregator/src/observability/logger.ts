import winston from 'winston';
import { getCorrelation } from '../infrastructure/correlation';

const correlationFormat = winston.format((info) => {
  const ctx = getCorrelation();
  if (ctx) {
    info.requestId = ctx.requestId;
    info.traceId = ctx.traceId;
  }
  return info;
});

function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack?.split('\n').slice(0, 3).join(' ') };
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    correlationFormat(),
    winston.format.timestamp(),
    winston.format.json({ replacer: (_key, value) => {
      if (value instanceof Error) {
        return { message: value.message, stack: value.stack?.split('\n').slice(0, 3).join(' ') };
      }
      return value;
    }}),
  ),
  defaultMeta: { service: 'stellar-price-oracle' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, stack, ...rest }) => {
          const extra = Object.keys(rest).length ? safeStringify(rest) : '';
          const stackTrace = stack ? `\n${stack}` : '';
          return `${timestamp} [${level}]: ${message} ${extra}${stackTrace}`;
        }),
      ),
    }),
  ],
});
