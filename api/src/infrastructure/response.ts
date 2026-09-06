/**
 * #302 — Discriminated unions for API response envelopes.
 *
 * API responses previously used a generic { success, data, error } shape in
 * which `success` was a plain `boolean` and `data`/`error` were only loosely
 * coupled to it. That meant a consumer (or the type checker) could not statically
 * guarantee that an object with `success: true` actually carries `data` and not
 * `error`. This module replaces those ad-hoc objects with proper discriminated
 * unions: `success` is the discriminant, and each variant narrows the payload
 * that is safe to read.
 *
 * Two envelope families are covered:
 *   - `Envelope<T>`   — the v1 REST shape `{ success, data } | { success, error }`.
 *   - `V2Envelope<T>` — the v2 REST shape keyed on `meta.success` inside a
 *     `{ meta, data } | { meta, error }` union, keeping v2's versioned meta.
 *
 * The builders (`ok`, `okCached`, `fail`, `v2Ok`, `v2Fail`) return the fully-typed,
 * discriminated objects; error responses produced by `AppError.toResponseObject()`
 * also flow through here.
 */

/** RFC7807-style error payload emitted on failure responses. Drawn from `AppError.toJSON()`. */
export interface ApiErrorPayload {
  /** Domain error code (present on legacy `{ code, message }` bodies). */
  code?: string;
  status?: number;
  type?: string;
  title?: string;
  detail?: string;
  message?: string;
  instance?: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── v1 envelope (top-level `success` discriminant) ───────────────────────────

export interface OkEnvelope<TData> {
  success: true;
  data: TData;
  error?: never;
  cached?: boolean;
}

export interface FailEnvelope {
  success: false;
  error: ApiErrorPayload;
  data?: never;
}

export type Envelope<TData> = OkEnvelope<TData> | FailEnvelope;

// ── v2 envelope (`meta.success` discriminant) ────────────────────────────────

export interface V2Meta {
  version: '2';
  success: boolean;
  cached?: boolean;
}

export interface V2OkEnvelope<TData> {
  meta: V2Meta & { success: true; cached?: boolean };
  data: TData;
  error?: never;
}

export interface V2FailEnvelope {
  meta: V2Meta & { success: false };
  error: ApiErrorPayload;
  data?: never;
}

export type V2Envelope<TData> = V2OkEnvelope<TData> | V2FailEnvelope;

// ── Builders ─────────────────────────────────────────────────────────────────

/** Build a discriminated success envelope: `{ success: true, data }`. */
export function ok<TData>(data: TData): OkEnvelope<TData> {
  return { success: true, data };
}

/** Build a discriminated success envelope with a `cached: true` marker. */
export function okCached<TData>(data: TData): OkEnvelope<TData> {
  return { success: true, data, cached: true };
}

/** Build a discriminated failure envelope: `{ success: false, error }`. */
export function fail(error: ApiErrorPayload): FailEnvelope {
  return { success: false, error };
}

/** Build a v2 success envelope keyed on `meta.success === true`. */
export function v2Ok<TData>(data: TData, cached = false): V2OkEnvelope<TData> {
  const meta: V2Meta & { success: true } = { version: '2', success: true };
  if (cached) meta.cached = true;
  return { meta, data };
}

/** Build a v2 failure envelope keyed on `meta.success === false`. */
export function v2Fail(error: ApiErrorPayload): V2FailEnvelope {
  return { meta: { version: '2', success: false }, error };
}