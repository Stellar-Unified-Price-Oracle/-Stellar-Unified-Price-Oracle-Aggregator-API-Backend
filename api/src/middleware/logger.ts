import { logger as winstonLogger } from '../observability/logger';

function normalize(messageOrMeta: unknown, maybeMessage?: string): [string, unknown?] {
  if (typeof maybeMessage === 'string') {
    return [maybeMessage, messageOrMeta];
  }
  return [String(messageOrMeta)];
}

export const logger = {
  debug(messageOrMeta: unknown, maybeMessage?: string): void {
    const [message, meta] = normalize(messageOrMeta, maybeMessage);
    winstonLogger.debug(message, meta);
  },
  info(messageOrMeta: unknown, maybeMessage?: string): void {
    const [message, meta] = normalize(messageOrMeta, maybeMessage);
    winstonLogger.info(message, meta);
  },
  warn(messageOrMeta: unknown, maybeMessage?: string): void {
    const [message, meta] = normalize(messageOrMeta, maybeMessage);
    winstonLogger.warn(message, meta);
  },
  error(messageOrMeta: unknown, maybeMessage?: string): void {
    const [message, meta] = normalize(messageOrMeta, maybeMessage);
    winstonLogger.error(message, meta);
  },
};
