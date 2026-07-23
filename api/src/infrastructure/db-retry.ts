import { Logger } from 'winston';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * PostgreSQL error codes (SQLSTATE) and node-pg error codes that represent
 * transient failures worth retrying. Anything else (e.g. constraint violations,
 * syntax errors) is a deterministic failure and must not be retried.
 */
const TRANSIENT_PG_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '55P03', // lock_not_available
]);

const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENOTFOUND',
]);

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (!code) {
    // Pool checkout timeouts surface as plain Errors with a known message.
    const message = (err as { message?: string }).message || '';
    return /timeout|terminat|connection/i.test(message);
  }
  return TRANSIENT_PG_CODES.has(code) || TRANSIENT_SYSTEM_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an operation with exponential backoff + full jitter, retrying only on
 * transient failures (issue #44).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  logger?: Logger,
  label = 'db operation',
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await operation();
    } catch (err) {
      attempt++;
      if (attempt > options.maxRetries || !isTransientError(err)) {
        throw err;
      }
      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * backoff); // full jitter
      logger?.warn(
        `Transient ${label} failure (attempt ${attempt}/${options.maxRetries}), retrying in ${delay}ms`,
        err,
      );
      await sleep(delay);
    }
  }
}
