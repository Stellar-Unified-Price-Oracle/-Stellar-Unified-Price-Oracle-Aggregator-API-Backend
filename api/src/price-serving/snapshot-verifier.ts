import * as crypto from 'crypto';

/** Schema versions the client-side verifier accepts. Bump only with a new ADR. */
export const SUPPORTED_SCHEMA_VERSIONS = [1];

/** Trusted verification keys published by the oracle operator. */
export interface TrustedKey {
  keyId: string;
  /** HMAC-SHA256 secret (base64) used to verify snapshots signed with this key. */
  secret: string;
  /** First seen at (Unix seconds) — keys older than this are not trusted. */
  activatedAt: number;
}

/** Example trusted keys. Operators replace these with their own published keys. */
export const TRUSTED_KEYS: Record<string, TrustedKey> = {
  'oracle-v1-primary': {
    keyId: 'oracle-v1-primary',
    secret: 'base64-encoded-hmac-secret-replaced-by-operator',
    activatedAt: 1700000000,
  },
};

/** A signed price snapshot as published by the oracle API. */
export interface SignedPriceSnapshot {
  schemaVersion: number;
  asset: string;
  price: string;
  decimals: number;
  timestamp: number;
  sources: string[];
  keyId: string;
  signature: string;
}

/** Outcome of verifying a snapshot. */
export interface VerificationResult {
  /** True when the snapshot passed all checks. */
  valid: boolean;
  /** The verified price, present only when valid. */
  price?: {
    asset: string;
    price: string;
    decimals: number;
    timestamp: number;
    sources: string[];
  };
  /** Present when invalid — one of UNSUPPORTED_SCHEMA, UNKNOWN_KEY, INVALID_SIGNATURE, MALFORMED. */
  rejection?: {
    code: 'UNSUPPORTED_SCHEMA' | 'UNKNOWN_KEY' | 'INVALID_SIGNATURE' | 'MALFORMED';
    message: string;
  };
}

/** Canonical payload over which the signature is computed. Field order is fixed. */
function canonicalPayload(snapshot: SignedPriceSnapshot): string {
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    asset: snapshot.asset,
    price: snapshot.price,
    decimals: snapshot.decimals,
    timestamp: snapshot.timestamp,
    sources: snapshot.sources,
  });
}

/**
 * Verify a signed price snapshot client-side.
 *
 * Checks, in order:
 *  1. Schema version is supported (rejects unsupported versions)
 *  2. Key id is known/trusted (rejects unknown keys)
 *  3. Signature matches HMAC-SHA256 of the canonical payload (rejects invalid signatures)
 *
 * The verifier never trusts a snapshot that fails any check. It is deterministic:
 * identical inputs always produce identical output.
 */
export function verifyPriceSnapshot(snapshot: SignedPriceSnapshot): VerificationResult {
  if (
    snapshot === null ||
    snapshot === undefined ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  ) {
    return { valid: false, rejection: { code: 'MALFORMED', message: 'snapshot must be an object' } };
  }

  if (typeof snapshot.schemaVersion !== 'number' || !Number.isInteger(snapshot.schemaVersion)) {
    return { valid: false, rejection: { code: 'MALFORMED', message: 'schemaVersion must be an integer' } };
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(snapshot.schemaVersion)) {
    return {
      valid: false,
      rejection: {
        code: 'UNSUPPORTED_SCHEMA',
        message: `schemaVersion ${snapshot.schemaVersion} is not supported; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
      },
    };
  }

  const key = TRUSTED_KEYS[snapshot.keyId];
  if (!key) {
    return {
      valid: false,
      rejection: {
        code: 'UNKNOWN_KEY',
        message: `keyId ${snapshot.keyId} is not a trusted verification key`,
      },
    };
  }

  if (typeof snapshot.signature !== 'string' || snapshot.signature.length === 0) {
    return { valid: false, rejection: { code: 'INVALID_SIGNATURE', message: 'signature is required' } };
  }

  const expected = crypto
    .createHmac('sha256', key.secret)
    .update(canonicalPayload(snapshot))
    .digest('hex');

  const provided = Buffer.from(snapshot.signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (!crypto.timingSafeEqual(provided, expectedBuf)) {
    return {
      valid: false,
      rejection: {
        code: 'INVALID_SIGNATURE',
        message: 'signature does not match the canonical payload',
      },
    };
  }

  return {
    valid: true,
    price: {
      asset: snapshot.asset,
      price: snapshot.price,
      decimals: snapshot.decimals,
      timestamp: snapshot.timestamp,
      sources: snapshot.sources,
    },
  };
}
