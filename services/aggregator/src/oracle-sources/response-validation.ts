import { z } from 'zod';
import BigNumber from 'bignumber.js';
import { logger } from '../observability/logger';

/**
 * Runtime schema validation for oracle provider responses (issue #584).
 *
 * Provider payloads previously flowed into `normalize` on the strength of
 * TypeScript interfaces alone, so a schema change surfaced as an opaque fetch
 * failure (or worse, as `NaN`/`BigInt` throw deep in the pipeline). Every
 * adapter now validates its response here and returns a typed result that
 * distinguishes three outcomes:
 *
 *  - `ok`             — payload matched the schema and a price can be read
 *  - `no-price`       — schema-valid, but the provider reports no quote for
 *                       the requested asset (asset simply not carried)
 *  - `invalid-payload`— the response did not match the expected schema; this
 *                       is a provider contract violation and is treated as a
 *                       first-class failure (metric + health state), not a
 *                       silent skip
 *
 * A transport error (network, timeout, HTTP failure) stays an exception in
 * the adapter layer and is counted by `fetchWithBackoff` as before.
 */

export type ProviderFetchResult =
  | { kind: 'ok'; price: string | number; decimals: number; observedAt: number | null }
  | { kind: 'no-price'; reason: string }
  | { kind: 'invalid-payload'; reason: string; issues: string };

export type ProviderSchemaName = 'chainlink' | 'redstone' | 'band' | 'reflector';

/** Hard bounds for decimals: scaling by 10^decimals must stay representable. */
export const MIN_DECIMALS = 0;
export const MAX_DECIMALS = 18;

// ── Shared field schemas ─────────────────────────────────────────────────────

const priceField = z.union([z.string(), z.number()]).refine(
  (value) => {
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    return value.trim().length > 0 && Number.isFinite(Number(value));
  },
  { message: 'price must be a finite number or a numeric string' },
);

const decimalsField = z
  .number({ invalid_type_error: 'decimals must be a number' })
  .int('decimals must be an integer')
  .min(MIN_DECIMALS, `decimals must be >= ${MIN_DECIMALS}`)
  .max(MAX_DECIMALS, `decimals must be <= ${MAX_DECIMALS}`);

const timestampSeconds = z
  .number({ invalid_type_error: 'timestamp must be a number' })
  .int('timestamp must be an integer')
  .nonnegative('timestamp must be non-negative');

// ── Per-provider response schemas ────────────────────────────────────────────

const chainlinkResponse = z
  .object({
    USD: z
      .object({
        PRICE: priceField,
      })
      .passthrough(),
  })
  .passthrough();

const redstoneEntry = z.object({
  value: priceField,
  decimals: decimalsField.optional(),
});

const redstoneResponse = z.record(z.string(), redstoneEntry.nullable()).nullable();

const bandFeedData = z.object({
  price: priceField,
  decimals: decimalsField.optional(),
  updated_at: timestampSeconds.optional(),
});

const bandResponse = z
  .object({
    data: bandFeedData.nullable(),
  })
  .passthrough();

const reflectorEntry = z.object({
  price: priceField,
  decimals: decimalsField.optional(),
  timestamp: timestampSeconds.optional(),
});

const reflectorResponse = z
  .object({
    prices: z.record(z.string(), reflectorEntry.nullable()).nullable(),
  })
  .passthrough();

const SCHEMAS: Record<ProviderSchemaName, z.ZodTypeAny> = {
  chainlink: chainlinkResponse,
  redstone: redstoneResponse,
  band: bandResponse,
  reflector: reflectorResponse,
};

// ── Error classification for the zero/NaN price rules ────────────────────────

function toFiniteNumber(value: string | number): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Extracts the asset quote from a validated payload, enforcing the
 * `invalid-payload` vs `no-price` distinction:
 *
 *  - a present-but-unreadable price (zero, negative, NaN) is
 *    `invalid-payload` — the provider answered but the value is unusable;
 *  - an absent entry (asset not carried, empty map, null envelope) is
 *    `no-price` — a legitimate state, not a contract violation.
 */
export function parseProviderResponse(
  schema: ProviderSchemaName,
  payload: unknown,
  asset: string,
): ProviderFetchResult {
  const parsed = SCHEMAS[schema].safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { kind: 'invalid-payload', reason: `${schema} response failed schema validation`, issues };
  }
  const data = parsed.data;

  switch (schema) {
    case 'chainlink': {
      const entry = (data as z.infer<typeof chainlinkResponse>).USD;
      if (!entry) {
        return { kind: 'no-price', reason: `no USD quote for ${asset}` };
      }
      const value = toFiniteNumber(entry.PRICE);
      if (value === null || value <= 0) {
        return {
          kind: 'invalid-payload',
          reason: `${schema} returned a non-positive or non-finite price for ${asset}`,
          issues: `PRICE=${String(entry.PRICE)}`,
        };
      }
      return { kind: 'ok', price: entry.PRICE, decimals: 8, observedAt: null };
    }

    case 'redstone': {
      const prices = data as z.infer<typeof redstoneResponse>;
      if (!prices) {
        return { kind: 'no-price', reason: 'empty prices envelope' };
      }
      const entry = prices[asset.toUpperCase()];
      if (!entry) {
        return { kind: 'no-price', reason: `asset ${asset} not present in prices map` };
      }
      const value = toFiniteNumber(entry.value);
      if (value === null || value <= 0) {
        return {
          kind: 'invalid-payload',
          reason: `${schema} returned a non-positive or non-finite price for ${asset}`,
          issues: `value=${String(entry.value)}`,
        };
      }
      return {
        kind: 'ok',
        price: entry.value,
        decimals: entry.decimals ?? 8,
        observedAt: null,
      };
    }

    case 'band': {
      const feed = (data as z.infer<typeof bandResponse>).data;
      if (!feed) {
        return { kind: 'no-price', reason: `no feed data for ${asset}` };
      }
      const value = toFiniteNumber(feed.price);
      if (value === null || value <= 0) {
        return {
          kind: 'invalid-payload',
          reason: `${schema} returned a non-positive or non-finite price for ${asset}`,
          issues: `price=${String(feed.price)}`,
        };
      }
      return {
        kind: 'ok',
        price: feed.price,
        decimals: feed.decimals ?? 9,
        observedAt: feed.updated_at ?? null,
      };
    }

    case 'reflector': {
      const prices = (data as z.infer<typeof reflectorResponse>).prices;
      if (!prices) {
        return { kind: 'no-price', reason: 'no prices envelope' };
      }
      const entry = prices[`Crypto.${asset.toUpperCase()}/USD`];
      if (!entry) {
        return { kind: 'no-price', reason: `asset ${asset} not present in prices map` };
      }
      const value = toFiniteNumber(entry.price);
      if (value === null || value <= 0) {
        return {
          kind: 'invalid-payload',
          reason: `${schema} returned a non-positive or non-finite price for ${asset}`,
          issues: `price=${String(entry.price)}`,
        };
      }
      return {
        kind: 'ok',
        price: entry.price,
        decimals: entry.decimals ?? 8,
        observedAt: entry.timestamp ?? null,
      };
    }
  }
}

/**
 * Normalizes a validated price into scaled bigint form, rejecting non-finite
 * or out-of-range values *before* scaling so `BigInt` can never throw on a
 * `NaN`/`Infinity` result. Scaling runs through `BigNumber` string math — the
 * same arithmetic the original `normalize` used — so legitimately large
 * prices at high decimals (e.g. wei-denominated feeds) keep full precision
 * instead of tripping a float-range guard.
 */
export function scaleValidatedPrice(
  price: string | number,
  decimals: number,
): { ok: true; scaled: bigint } | { ok: false; reason: string } {
  if (!Number.isInteger(decimals) || decimals < MIN_DECIMALS || decimals > MAX_DECIMALS) {
    return { ok: false, reason: `decimals ${decimals} outside [${MIN_DECIMALS}, ${MAX_DECIMALS}]` };
  }

  const bn = new BigNumber(price);
  if (!bn.isFinite() || bn.isLessThanOrEqualTo(0)) {
    return { ok: false, reason: `price ${String(price)} is not a positive finite number` };
  }

  const scaled = bn.multipliedBy(new BigNumber(10).pow(decimals));
  if (!scaled.isFinite()) {
    return { ok: false, reason: `price ${String(price)} overflows at ${decimals} decimals` };
  }

  const scaledString = scaled.toFixed(0);
  const scaledInt = BigInt(scaledString);
  if (scaledInt <= 0n) {
    return { ok: false, reason: 'scaled price rounded to zero' };
  }
  return { ok: true, scaled: scaledInt };
}

/** Logs an invalid payload with enough context to debug a schema change. */
export function reportInvalidPayload(
  source: string,
  asset: string,
  result: Extract<ProviderFetchResult, { kind: 'invalid-payload' }>,
  payload: unknown,
): void {
  logger.error(
    `[${source}] Provider response failed schema validation for ${asset} — operator alert required`,
    {
      source,
      asset,
      reason: result.reason,
      issues: result.issues,
      payloadPreview: safePreview(payload),
    },
  );
}

function safePreview(payload: unknown): string {
  try {
    const json = JSON.stringify(payload);
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  } catch {
    return String(payload);
  }
}
