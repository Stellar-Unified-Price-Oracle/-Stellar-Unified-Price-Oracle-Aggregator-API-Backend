/**
 * Feed alias and retirement semantics (issue #673).
 *
 * When a feed is renamed, merged into another feed or retired, existing
 * consumers that still use the old identifier must keep working for a bounded
 * period. The registry below records, per alias:
 *
 *   - the canonical feed the alias now resolves to (`successor`), or
 *   - `null` when the feed was retired without a successor,
 *   - the time at which the alias stops resolving (`sunsetAt`),
 *   - a human-readable removal notice surfaced in API responses.
 *
 * The alias window is explicit and bounded so an alias can never become a
 * permanent, undocumented compatibility shim.
 */

export type FeedAliasKind = 'rename' | 'merge' | 'retirement';

export interface FeedAliasEntry {
  /** The identifier consumers used before the change. */
  alias: string;
  /** The feed the alias now resolves to; `null` for a retired feed. */
  successor: string | null;
  kind: FeedAliasKind;
  /** ISO timestamp after which the alias no longer resolves. */
  sunsetAt: string;
  /** Consumer-facing notice, e.g. "renamed to BTC/USD". */
  notice: string;
  /** When the alias was registered. */
  registeredAt: string;
  /** Who registered the alias. */
  registeredBy: string;
}

export interface FeedAliasResolution {
  /** Alias that was looked up (normalised). */
  alias: string;
  /** Feed the alias currently resolves to, `null` when retired. */
  resolvedFeed: string | null;
  /** True when the alias was found in the registry. */
  known: boolean;
  /** True when the alias is past its sunset date. */
  expired: boolean;
  /** True when the alias points at a successor feed. */
  redirected: boolean;
  kind: FeedAliasKind | null;
  notice: string | null;
  sunsetAt: string | null;
}

export type FeedAliasErrorCode =
  | 'ALIAS_EXISTS'
  | 'INVALID_ALIAS'
  | 'INVALID_SUCCESSOR'
  | 'INVALID_SUNSET'
  | 'ALIAS_NOT_FOUND';

export interface FeedAliasError {
  code: FeedAliasErrorCode;
  message: string;
}

export type FeedAliasResult =
  | { ok: true; entry: FeedAliasEntry }
  | { ok: false; error: FeedAliasError };

export interface FeedAliasRegistry {
  register(entry: FeedAliasEntry): FeedAliasResult;
  get(alias: string): FeedAliasEntry | undefined;
  list(): FeedAliasEntry[];
  remove(alias: string): boolean;
}

export function createFeedAliasRegistry(): FeedAliasRegistry {
  const entries = new Map<string, FeedAliasEntry>();
  const normalize = (alias: string) => alias.trim().toUpperCase();

  return {
    register(entry: FeedAliasEntry): FeedAliasResult {
      const alias = normalize(entry.alias);
      if (alias.length === 0) {
        return { ok: false, error: { code: 'INVALID_ALIAS', message: 'alias must not be empty' } };
      }
      if (entry.successor !== null && entry.successor.trim().length === 0) {
        return {
          ok: false,
          error: { code: 'INVALID_SUCCESSOR', message: 'successor must be null or a feed id' },
        };
      }
      if (entry.kind === 'merge' && entry.successor === null) {
        return {
          ok: false,
          error: { code: 'INVALID_SUCCESSOR', message: 'a merged alias must name a successor feed' },
        };
      }
      if (entry.kind === 'retirement' && entry.successor !== null) {
        return {
          ok: false,
          error: {
            code: 'INVALID_SUCCESSOR',
            message: 'a retired alias must not name a successor feed',
          },
        };
      }
      const sunset = Date.parse(entry.sunsetAt);
      if (Number.isNaN(sunset)) {
        return { ok: false, error: { code: 'INVALID_SUNSET', message: 'sunsetAt must be an ISO timestamp' } };
      }
      if (sunset <= Date.parse(entry.registeredAt)) {
        return {
          ok: false,
          error: { code: 'INVALID_SUNSET', message: 'sunsetAt must be after registeredAt' },
        };
      }
      if (entries.has(alias)) {
        return { ok: false, error: { code: 'ALIAS_EXISTS', message: `alias ${alias} is already registered` } };
      }
      const stored: FeedAliasEntry = { ...entry, alias, successor: entry.successor?.trim() ?? null };
      entries.set(alias, stored);
      return { ok: true, entry: stored };
    },
    get(alias: string) {
      return entries.get(normalize(alias));
    },
    list() {
      return [...entries.values()];
    },
    remove(alias: string) {
      return entries.delete(normalize(alias));
    },
  };
}

/**
 * Resolve an alias. Expired aliases still resolve to their successor (so a
 * consumer is never silently pointed at the wrong feed) but are flagged as
 * expired so the caller can add the removal notice to the response.
 */
export function resolveFeedAlias(
  registry: FeedAliasRegistry,
  alias: string,
  now: Date = new Date(),
): FeedAliasResolution {
  const normalized = alias.trim().toUpperCase();
  const entry = registry.get(normalized);
  if (!entry) {
    return {
      alias: normalized,
      resolvedFeed: null,
      known: false,
      expired: false,
      redirected: false,
      kind: null,
      notice: null,
      sunsetAt: null,
    };
  }

  const expired = Date.parse(entry.sunsetAt) <= now.getTime();
  return {
    alias: normalized,
    resolvedFeed: entry.successor,
    known: true,
    expired,
    redirected: entry.successor !== null,
    kind: entry.kind,
    notice: entry.notice,
    sunsetAt: entry.sunsetAt,
  };
}

/** Aliases whose sunset date has passed and can be removed from the registry. */
export function expiredFeedAliases(
  registry: FeedAliasRegistry,
  now: Date = new Date(),
): FeedAliasEntry[] {
  return registry
    .list()
    .filter((entry) => Date.parse(entry.sunsetAt) <= now.getTime());
}

/**
 * Response metadata attached to a price response when the requested feed was
 * served through an alias. Surfaced under `meta.alias`.
 */
export interface FeedAliasMetadata {
  requestedAlias: string;
  canonicalFeed: string;
  aliasKind: FeedAliasKind;
  notice: string;
  sunsetAt: string;
  deprecated: boolean;
}

export function aliasMetadata(
  resolution: FeedAliasResolution,
): FeedAliasMetadata | null {
  if (!resolution.known || resolution.resolvedFeed === null) return null;
  return {
    requestedAlias: resolution.alias,
    canonicalFeed: resolution.resolvedFeed,
    aliasKind: resolution.kind as FeedAliasKind,
    notice: resolution.notice ?? '',
    sunsetAt: resolution.sunsetAt ?? '',
    deprecated: resolution.expired,
  };
}
