/**
 * Standardized Result type for the aggregator (issue #299).
 *
 * Functions that can fail return `Result<T, E>` instead of throwing or
 * silently swallowing errors, so callers must handle both outcomes and every
 * failure is logged with context at the call site.
 */

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok === true;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return result.ok === false;
}

/** Return the wrapped value, or the provided fallback on failure. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Wrap a throwing function in a Result. The error is normalized to an Error
 * instance so callers can rely on `.message` for logging.
 */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    return err(error);
  }
}

/** Like tryCatch, but for async functions. */
export async function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    return err(error);
  }
}
