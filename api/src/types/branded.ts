/**
 * Branded (nominal) types for core domain values.
 *
 * A branded type carries an invisible "brand" tag that forces callers to go
 * through the provided constructor/guard, preventing accidental confusion of
 * structurally identical primitives (e.g. using a raw string as a PriceId).
 *
 * Usage:
 *   const id = PriceId('xlm_usd');          // construct
 *   function foo(id: PriceId) { ... }        // typed parameter
 *   if (isPriceId(value)) { ... }            // type guard
 */

// ---------------------------------------------------------------------------
// Brand utility
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;

/**
 * `Brand<T, B>` is `T` at runtime but carries a phantom brand tag `B` that
 * TypeScript uses to distinguish it from a plain `T`.
 */
type Brand<T, B> = T & { readonly [__brand]: B };

// ---------------------------------------------------------------------------
// Domain branded types
// ---------------------------------------------------------------------------

/**
 * Opaque identifier for a price record — e.g. `"xlm_usd@1720000000000"`.
 * Prevents passing arbitrary strings where a validated price ID is expected.
 */
export type PriceId = Brand<string, 'PriceId'>;

export function PriceId(raw: string): PriceId {
  if (!raw || typeof raw !== 'string') {
    throw new TypeError(`Invalid PriceId: expected non-empty string, got ${JSON.stringify(raw)}`);
  }
  return raw as PriceId;
}

export function isPriceId(value: unknown): value is PriceId {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------

/**
 * An asset-pair symbol in the canonical `BASE_QUOTE` format, e.g. `"XLM_USD"`.
 * Both segments are upper-cased ASCII codes (3–12 chars each).
 */
export type AssetPair = Brand<string, 'AssetPair'>;

const ASSET_PAIR_RE = /^[A-Z]{3,12}_[A-Z]{3,12}$/;

export function AssetPair(raw: string): AssetPair {
  const normalised = raw.trim().toUpperCase();
  if (!ASSET_PAIR_RE.test(normalised)) {
    throw new TypeError(
      `Invalid AssetPair "${raw}": expected BASE_QUOTE with 3–12 uppercase ASCII chars each.`
    );
  }
  return normalised as AssetPair;
}

export function isAssetPair(value: unknown): value is AssetPair {
  return typeof value === 'string' && ASSET_PAIR_RE.test(value);
}

// ---------------------------------------------------------------------------

/**
 * A price expressed as a fixed-point decimal string to avoid floating-point
 * rounding errors (e.g. `"0.12345678"`).
 */
export type PriceDecimal = Brand<string, 'PriceDecimal'>;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function PriceDecimal(raw: string | number): PriceDecimal {
  const s = String(raw).trim();
  if (!DECIMAL_RE.test(s)) {
    throw new TypeError(`Invalid PriceDecimal "${raw}": expected numeric string.`);
  }
  return s as PriceDecimal;
}

export function isPriceDecimal(value: unknown): value is PriceDecimal {
  return typeof value === 'string' && DECIMAL_RE.test(value);
}

// ---------------------------------------------------------------------------

/**
 * A Unix timestamp in milliseconds (integer ≥ 0).
 */
export type TimestampMs = Brand<number, 'TimestampMs'>;

export function TimestampMs(raw: number): TimestampMs {
  if (!Number.isInteger(raw) || raw < 0) {
    throw new TypeError(`Invalid TimestampMs ${raw}: expected non-negative integer.`);
  }
  return raw as TimestampMs;
}

export function isTimestampMs(value: unknown): value is TimestampMs {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------

/**
 * An oracle source identifier — e.g. `"band_protocol"` or `"pyth_network"`.
 */
export type OracleSourceId = Brand<string, 'OracleSourceId'>;

export function OracleSourceId(raw: string): OracleSourceId {
  if (!raw || typeof raw !== 'string') {
    throw new TypeError(`Invalid OracleSourceId: ${JSON.stringify(raw)}`);
  }
  return raw.trim().toLowerCase() as OracleSourceId;
}

export function isOracleSourceId(value: unknown): value is OracleSourceId {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Phantom types for state machines
// ---------------------------------------------------------------------------

/**
 * PriceState — phantom type encoding the lifecycle of a price update.
 *
 * Transitions: Pending → Fetched → Validated → Published
 *                               └→ Invalid (terminal)
 */
export type PriceStatePending   = Brand<never, 'PriceState:Pending'>;
export type PriceStateFetched   = Brand<never, 'PriceState:Fetched'>;
export type PriceStateValidated = Brand<never, 'PriceState:Validated'>;
export type PriceStatePublished = Brand<never, 'PriceState:Published'>;
export type PriceStateInvalid   = Brand<never, 'PriceState:Invalid'>;

export type PriceState =
  | PriceStatePending
  | PriceStateFetched
  | PriceStateValidated
  | PriceStatePublished
  | PriceStateInvalid;

/** Tagged price update record that carries its state in the type. */
export interface PriceUpdate<S extends PriceState = PriceState> {
  readonly pair: AssetPair;
  readonly price: PriceDecimal;
  readonly source: OracleSourceId;
  readonly fetchedAt: TimestampMs;
  readonly _state: S;
}
