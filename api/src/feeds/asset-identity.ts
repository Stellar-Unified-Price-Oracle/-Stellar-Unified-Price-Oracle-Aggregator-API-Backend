/**
 * Canonical asset identity for the feed catalog (issue #671).
 *
 * A Stellar asset is only unique when the issuer *and* the network are known:
 * `USDC` exists on both testnet and public network, and several issuers ship
 * the same ticker. The canonical id therefore always carries all three
 * components:
 *
 *     <network>:<CODE>:<ISSUER>          e.g. public:USDC:GA5ZSEJY…
 *     <network>:XLM:native               native asset has no issuer
 *
 * The format is deliberately plain text so it can appear in URLs, log lines,
 * metric labels and audit records without a serialisation step.
 */

export type StellarNetwork = 'public' | 'testnet' | 'futurenet' | 'local';

export const STELLAR_NETWORKS: readonly StellarNetwork[] = [
  'public',
  'testnet',
  'futurenet',
  'local',
];

export const NATIVE_ASSET_CODE = 'XLM';

export interface CanonicalAsset {
  network: StellarNetwork;
  code: string;
  /** `null` only for the native asset (XLM). */
  issuer: string | null;
}

export const ASSET_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;
export const ASSET_ISSUER_PATTERN = /^G[A-Z0-9]{55}$/;

/** Human-friendly spellings accepted wherever a network is expected. */
const NETWORK_ALIASES: Record<string, StellarNetwork> = {
  PUBLIC: 'public',
  MAINNET: 'public',
  'PUBLIC NETWORK': 'public',
  TESTNET: 'testnet',
  'TEST NETWORK': 'testnet',
  HORIZONTESTNET: 'testnet',
  FUTURENET: 'futurenet',
  'FUTURE NETWORK': 'futurenet',
  LOCAL: 'local',
  SANDBOX: 'local',
};

/**
 * Map a Stellar network passphrase onto the network name used in canonical
 * asset ids. Unknown passphrases are rejected rather than guessed, because a
 * wrong network silently splits one asset into two identities.
 */
export function networkFromPassphrase(passphrase: string): StellarNetwork | null {
  const value = passphrase.trim().toLowerCase();
  if (value.includes('public global stellar network')) return 'public';
  if (value.includes('test sdf future network')) return 'futurenet';
  if (value.includes('test sdf network')) return 'testnet';
  if (value.includes('local')) return 'local';
  return null;
}

export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return typeof value === 'string' && (STELLAR_NETWORKS as readonly string[]).includes(value);
}

export function normalizeNetwork(value: string): StellarNetwork | null {
  const trimmed = value.trim();
  const key = trimmed.toUpperCase();
  const aliased = NETWORK_ALIASES[key];
  if (aliased) return aliased;
  const lowered = trimmed.toLowerCase();
  return isStellarNetwork(lowered) ? lowered : null;
}

export function isValidAssetCode(code: string): boolean {
  return ASSET_CODE_PATTERN.test(code);
}

export function isValidIssuer(issuer: string): boolean {
  return ASSET_ISSUER_PATTERN.test(issuer);
}

/** Serialise an asset into the canonical `<network>:<CODE>:<ISSUER>` form. */
export function formatCanonicalAssetId(asset: CanonicalAsset): string {
  const issuer = asset.issuer === null ? 'native' : asset.issuer;
  return `${asset.network}:${asset.code}:${issuer}`;
}

/**
 * Parse a canonical asset id. Returns `null` when the value is not in the
 * canonical form — callers that accept user input should use
 * `resolveAssetAlias` instead, which understands aliases as well.
 */
export function parseCanonicalAssetId(value: string): CanonicalAsset | null {
  const parts = value.trim().split(':');
  if (parts.length !== 3) return null;

  const network = normalizeNetwork(parts[0]);
  if (network === null) return null;

  const code = parts[1].trim().toUpperCase();
  if (!isValidAssetCode(code)) return null;

  const rawIssuer = parts[2].trim().toUpperCase();
  let issuer: string | null;
  if (rawIssuer === 'NATIVE') {
    issuer = null;
  } else if (isValidIssuer(rawIssuer)) {
    issuer = rawIssuer;
  } else {
    return null;
  }

  if (issuer === null && code !== NATIVE_ASSET_CODE) return null;
  if (issuer !== null && code === NATIVE_ASSET_CODE) return null;

  return { network, code, issuer };
}

export function isCanonicalAssetId(value: string): boolean {
  return parseCanonicalAssetId(value) !== null;
}

export interface AssetAliasRegistration {
  /** Alias as published by consumers, e.g. `USDC` or `GA5Z…:USDC`. */
  alias: string;
  /** The canonical id the alias resolves to. */
  canonicalId: string;
}

export type AssetResolutionReason = 'INVALID_ALIAS' | 'NOT_FOUND' | 'AMBIGUOUS';

export interface AssetResolutionSuccess {
  ok: true;
  canonicalId: string;
  asset: CanonicalAsset;
  matchedAlias: string;
  resolution: 'canonical' | 'registry' | 'native';
}

export interface AssetResolutionFailure {
  ok: false;
  reason: AssetResolutionReason;
  message: string;
  /** Populated for `AMBIGUOUS` so the caller can surface the choices. */
  candidates?: string[];
}

export type AssetResolutionResult = AssetResolutionSuccess | AssetResolutionFailure;

export interface AssetResolutionOptions {
  /** Network assumed when the alias carries no network component. */
  defaultNetwork?: StellarNetwork;
}

function registryLookupByAlias(
  registry: AssetAliasRegistration[],
  alias: string,
): AssetAliasRegistration[] {
  const target = alias.trim().toUpperCase();
  return registry.filter((entry) => entry.alias.trim().toUpperCase() === target);
}

function registryLookupByCode(
  registry: AssetAliasRegistration[],
  code: string,
): AssetAliasRegistration[] {
  const target = code.trim().toUpperCase();
  return registry.filter((entry) => {
    const parsed = parseCanonicalAssetId(entry.canonicalId);
    return parsed !== null && parsed.code === target;
  });
}

/**
 * Resolve any supported asset spelling onto its canonical id.
 *
 * Supported inputs:
 *   - canonical ids            `public:USDC:GA5Z…`
 *   - code + issuer            `USDC:GA5Z…`, `GA5Z…:USDC`
 *   - network-qualified code   `public:XLM` (native only)
 *   - bare code                `USDC` (resolved through the alias registry)
 *   - bare native code         `XLM`
 *
 * Resolution is deterministic: the first matching rule wins, and a bare code
 * that matches more than one issuer is reported as ambiguous rather than
 * resolved to an arbitrary candidate.
 */
export function resolveAssetAlias(
  input: string,
  registry: AssetAliasRegistration[] = [],
  options: AssetResolutionOptions = {},
): AssetResolutionResult {
  const defaultNetwork = options.defaultNetwork ?? 'public';
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'INVALID_ALIAS', message: 'Asset alias must not be empty' };
  }

  const upper = trimmed.toUpperCase();
  const parts = upper.split(':');

  if (parts.length === 3) {
    const asset = parseCanonicalAssetId(upper);
    if (asset === null) {
      return {
        ok: false,
        reason: 'INVALID_ALIAS',
        message: `"${trimmed}" is not a valid canonical asset id (expected <network>:<CODE>:<ISSUER>)`,
      };
    }
    return {
      ok: true,
      canonicalId: formatCanonicalAssetId(asset),
      asset,
      matchedAlias: upper,
      resolution: 'canonical',
    };
  }

  if (parts.length === 2) {
    const [first, second] = parts;

    const firstIsNetwork = normalizeNetwork(first) !== null;
    const secondIsNetwork = normalizeNetwork(second) !== null;

    if (firstIsNetwork || secondIsNetwork) {
      const network = normalizeNetwork(firstIsNetwork ? first : second) as StellarNetwork;
      const code = (firstIsNetwork ? second : first).trim();
      if (!isValidAssetCode(code)) {
        return { ok: false, reason: 'INVALID_ALIAS', message: `"${code}" is not a valid asset code` };
      }
      if (code !== NATIVE_ASSET_CODE) {
        return {
          ok: false,
          reason: 'INVALID_ALIAS',
          message: `Asset ${code} requires an issuer; use <network>:${code}:<ISSUER>`,
        };
      }
      const asset: CanonicalAsset = { network, code, issuer: null };
      return {
        ok: true,
        canonicalId: formatCanonicalAssetId(asset),
        asset,
        matchedAlias: upper,
        resolution: 'canonical',
      };
    }

    const firstIsIssuer = isValidIssuer(first);
    const secondIsIssuer = isValidIssuer(second);

    if (firstIsIssuer && secondIsIssuer) {
      return {
        ok: false,
        reason: 'AMBIGUOUS',
        message: `"${trimmed}" names two issuers and cannot be resolved deterministically`,
        candidates: [first, second],
      };
    }

    if (firstIsIssuer || secondIsIssuer) {
      const issuer = firstIsIssuer ? first : second;
      const code = firstIsIssuer ? second : first;
      if (!isValidAssetCode(code)) {
        return { ok: false, reason: 'INVALID_ALIAS', message: `"${code}" is not a valid asset code` };
      }
      const asset: CanonicalAsset = { network: defaultNetwork, code, issuer };
      return {
        ok: true,
        canonicalId: formatCanonicalAssetId(asset),
        asset,
        matchedAlias: upper,
        resolution: 'canonical',
      };
    }

    const registered = registryLookupByAlias(registry, upper);
    if (registered.length > 0) {
      return resolveRegisteredAliases(registered, upper);
    }

    return resolveBareCode(upper, registry, defaultNetwork);
  }

  if (parts.length === 1) {
    const registered = registryLookupByAlias(registry, upper);
    if (registered.length > 0) {
      return resolveRegisteredAliases(registered, upper);
    }
    return resolveBareCode(upper, registry, defaultNetwork);
  }

  return {
    ok: false,
    reason: 'INVALID_ALIAS',
    message: `"${trimmed}" is not a recognised asset alias`,
  };
}

function resolveRegisteredAliases(
  matches: AssetAliasRegistration[],
  alias: string,
): AssetResolutionResult {
  const distinct = new Map<string, AssetAliasRegistration>();
  for (const match of matches) {
    distinct.set(match.canonicalId, match);
  }
  if (distinct.size > 1) {
    const candidates = [...distinct.keys()].sort();
    return {
      ok: false,
      reason: 'AMBIGUOUS',
      message: `Alias "${alias}" matches ${candidates.length} canonical assets; use the canonical id`,
      candidates,
    };
  }
  const only = [...distinct.values()][0];
  return resolveCanonicalOrFail(only.canonicalId, alias);
}

function resolveCanonicalOrFail(canonicalId: string, matchedAlias: string): AssetResolutionResult {
  const asset = parseCanonicalAssetId(canonicalId);
  if (asset === null) {
    return {
      ok: false,
      reason: 'INVALID_ALIAS',
      message: `Registered alias "${matchedAlias}" points at an invalid canonical id "${canonicalId}"`,
    };
  }
  return {
    ok: true,
    canonicalId: formatCanonicalAssetId(asset),
    asset,
    matchedAlias,
    resolution: 'registry',
  };
}

function resolveBareCode(
  code: string,
  registry: AssetAliasRegistration[],
  defaultNetwork: StellarNetwork,
): AssetResolutionResult {
  if (!isValidAssetCode(code)) {
    return { ok: false, reason: 'INVALID_ALIAS', message: `"${code}" is not a valid asset code` };
  }

  const distinct = new Map<string, AssetAliasRegistration>();
  for (const match of registryLookupByCode(registry, code)) {
    distinct.set(match.canonicalId, match);
  }

  if (distinct.size === 1) {
    const only = [...distinct.values()][0];
    return resolveCanonicalOrFail(only.canonicalId, code);
  }

  if (distinct.size > 1) {
    const candidates = [...distinct.keys()].sort();
    return {
      ok: false,
      reason: 'AMBIGUOUS',
      message: `Asset code ${code} matches ${candidates.length} issuers; specify the issuer or the canonical id`,
      candidates,
    };
  }

  if (code === NATIVE_ASSET_CODE) {
    const asset: CanonicalAsset = { network: defaultNetwork, code, issuer: null };
    return {
      ok: true,
      canonicalId: formatCanonicalAssetId(asset),
      asset,
      matchedAlias: code,
      resolution: 'native',
    };
  }

  return {
    ok: false,
    reason: 'NOT_FOUND',
    message: `No canonical asset is registered for "${code}"`,
  };
}
