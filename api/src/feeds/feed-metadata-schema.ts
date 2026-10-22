/**
 * Versioned feed metadata schema (issue #669).
 *
 * `schemaVersion` is the major version and changes only on a breaking change.
 * `schemaRevision` is an additive revision within that major and defaults to 0.
 * The JSON schema shipped at
 * `packages/sdk-bindings/schema/feed-metadata.v2.schema.json` is the canonical
 * artifact; this module is the runtime reader/writer used by the API.
 */

export const FEED_METADATA_SCHEMA_MAJOR = 2 as const;
export const FEED_METADATA_SCHEMA_REVISION = 0 as const;

export type FeedNetwork = 'stellar:pubnet' | 'stellar:testnet' | 'stellar:futurenet';
export type FeedLifecycleState =
  | 'proposed'
  | 'canary'
  | 'active'
  | 'paused'
  | 'deprecated'
  | 'retired';

export interface FeedUnit {
  asset: string;
  issuer?: string | null;
  decimals: number;
}

export interface EligibleSource {
  source: 'chainlink' | 'redstone' | 'band' | 'reflector';
  weightBps: number;
  required: boolean;
}

export interface FreshnessProfile {
  heartbeatSeconds: number;
  maxStalenessSeconds: number;
  deviationThresholdBps?: number;
}

export interface FeedOwnership {
  team: string;
  owner: string;
  oncall: string;
}

export interface FeedLifecycleMetadata {
  state: FeedLifecycleState;
  since: string;
  successorFeedId?: string;
  reason?: string;
}

export interface FeedMetadataDocument {
  schemaVersion: number;
  schemaRevision?: number;
  feedId: string;
  network: FeedNetwork;
  base: FeedUnit;
  quote: FeedUnit;
  precision: number;
  eligibleSources: EligibleSource[];
  freshness: FreshnessProfile;
  ownership: FeedOwnership;
  lifecycle: FeedLifecycleMetadata;
  [key: string]: unknown;
}

export interface FeedMetadataSchemaVersion {
  major: number;
  revision: number;
}

export const CURRENT_FEED_METADATA_READER: FeedMetadataSchemaVersion = {
  major: FEED_METADATA_SCHEMA_MAJOR,
  revision: FEED_METADATA_SCHEMA_REVISION,
};

export type FeedMetadataValidationCode =
  | 'NOT_OBJECT'
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'INVALID_TYPE'
  | 'INVALID_VALUE'
  | 'UNSUPPORTED_VERSION';

export interface FeedMetadataValidationError {
  path: string;
  code: FeedMetadataValidationCode;
  message: string;
}

export interface FeedMetadataValidationSuccess {
  ok: true;
  metadata: FeedMetadataDocument;
}

export type FeedMetadataValidationResult =
  | FeedMetadataValidationSuccess
  | { ok: false; errors: FeedMetadataValidationError[] };

export type CompatibilityMode = 'exact' | 'backward-compatible' | 'forward-degraded';

export interface CompatibilityAssessment {
  compatible: boolean;
  mode?: CompatibilityMode;
  reason: string;
}

export interface ReadFeedMetadataSuccess extends FeedMetadataValidationSuccess {
  compatibility: CompatibilityAssessment;
}

export type ReadFeedMetadataResult =
  | ReadFeedMetadataSuccess
  | { ok: false; errors: FeedMetadataValidationError[] };

const NETWORKS: readonly string[] = ['stellar:pubnet', 'stellar:testnet', 'stellar:futurenet'];
const SOURCES: readonly string[] = ['chainlink', 'redstone', 'band', 'reflector'];
const STATES: readonly string[] = ['proposed', 'canary', 'active', 'paused', 'deprecated', 'retired'];
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'schemaRevision',
  'feedId',
  'network',
  'base',
  'quote',
  'precision',
  'eligibleSources',
  'freshness',
  'ownership',
  'lifecycle',
]);
const FEED_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

export function parseFeedMetadataSchemaVersion(value: unknown): FeedMetadataSchemaVersion | null {
  if (!isObject(value)) return null;
  const major = value.schemaVersion;
  const revision = value.schemaRevision ?? 0;
  if (!Number.isInteger(major) || (major as number) < 1) return null;
  if (!Number.isInteger(revision) || (revision as number) < 0) return null;
  return { major: major as number, revision: revision as number };
}

export function assessFeedMetadataCompatibility(
  document: unknown,
  reader: FeedMetadataSchemaVersion = CURRENT_FEED_METADATA_READER,
): CompatibilityAssessment {
  const version = parseFeedMetadataSchemaVersion(document);
  if (version === null) {
    return { compatible: false, reason: 'document does not declare a valid integer schemaVersion and schemaRevision' };
  }
  if (version.major !== reader.major) {
    return {
      compatible: false,
      reason: `document major ${version.major} is not readable by a major ${reader.major} reader; upgrade the reader`,
    };
  }
  if (version.revision > reader.revision) {
    return {
      compatible: true,
      mode: 'forward-degraded',
      reason: `document revision ${version.revision} is newer than reader revision ${reader.revision}; unknown optional fields are ignored`,
    };
  }
  if (version.revision < reader.revision) {
    return {
      compatible: true,
      mode: 'backward-compatible',
      reason: `document revision ${version.revision} is older than reader revision ${reader.revision}; absent optional fields use their defaults`,
    };
  }
  return { compatible: true, mode: 'exact', reason: `document and reader are both ${version.major}.${version.revision}` };
}

/**
 * Validate a feed metadata document.
 *
 * Writers/CI use the default `strict` mode so typos and unknown fields fail the
 * build. Readers call with `strict: false`: within the same major version they
 * must ignore unknown optional fields rather than reject the document.
 */
export function validateFeedMetadata(
  value: unknown,
  options: { strict?: boolean; reader?: FeedMetadataSchemaVersion } = {},
): FeedMetadataValidationResult {
  const strict = options.strict ?? true;
  const reader = options.reader ?? CURRENT_FEED_METADATA_READER;
  const errors: FeedMetadataValidationError[] = [];
  const add = (path: string, code: FeedMetadataValidationCode, message: string) => {
    errors.push({ path, code, message });
  };

  if (!isObject(value)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'feed metadata must be an object' }] };
  }

  const version = parseFeedMetadataSchemaVersion(value);
  if (version === null) {
    add('$.schemaVersion', 'INVALID_VALUE', 'schemaVersion must be a positive integer and schemaRevision a non-negative integer');
  } else if (version.major !== reader.major) {
    add('$.schemaVersion', 'UNSUPPORTED_VERSION', `major version ${version.major} is not supported by this reader (${reader.major})`);
  }

  if (strict) {
    for (const key of Object.keys(value)) {
      if (!TOP_LEVEL_FIELDS.has(key)) add(`$.${key}`, 'UNKNOWN_FIELD', `unknown field "${key}"`);
    }
  }

  requireString(value, 'feedId', add);
  if (typeof value.feedId === 'string' && !FEED_ID.test(value.feedId)) {
    add('$.feedId', 'INVALID_VALUE', 'feedId must be lower-case kebab-case');
  }

  requireEnum(value, 'network', NETWORKS, add);
  validateUnit(value.base, '$.base', add);
  validateUnit(value.quote, '$.quote', add);

  if (!Number.isInteger(value.precision) || (value.precision as number) < 0 || (value.precision as number) > 18) {
    add('$.precision', 'INVALID_VALUE', 'precision must be an integer between 0 and 18');
  }

  validateSources(value.eligibleSources, add);
  validateFreshness(value.freshness, add);
  validateOwnership(value.ownership, add);
  validateLifecycle(value.lifecycle, value.feedId, add);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, metadata: value as FeedMetadataDocument };
}

export function readFeedMetadata(
  value: unknown,
  reader: FeedMetadataSchemaVersion = CURRENT_FEED_METADATA_READER,
): ReadFeedMetadataResult {
  const compatibility = assessFeedMetadataCompatibility(value, reader);
  if (!compatibility.compatible) {
    return {
      ok: false,
      errors: [{ path: '$.schemaVersion', code: 'UNSUPPORTED_VERSION', message: compatibility.reason }],
    };
  }
  const validation = validateFeedMetadata(value, { strict: false, reader });
  if (!validation.ok) return validation;
  return { ...validation, compatibility };
}

type AddError = (path: string, code: FeedMetadataValidationCode, message: string) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, add: AddError): void {
  if (value[key] === undefined) {
    add(`$.${key}`, 'MISSING_FIELD', `${key} is required`);
  } else if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
    add(`$.${key}`, 'INVALID_TYPE', `${key} must be a non-empty string`);
  }
}

function requireEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  add: AddError,
): void {
  if (value[key] === undefined) {
    add(`$.${key}`, 'MISSING_FIELD', `${key} is required`);
  } else if (typeof value[key] !== 'string' || !allowed.includes(value[key] as string)) {
    add(`$.${key}`, 'INVALID_VALUE', `${key} must be one of: ${allowed.join(', ')}`);
  }
}

function validateUnit(value: unknown, path: string, add: AddError): void {
  if (!isObject(value)) {
    add(path, 'MISSING_FIELD', 'unit is required and must be an object');
    return;
  }
  if (typeof value.asset !== 'string' || value.asset.length === 0 || value.asset.length > 12) {
    add(`${path}.asset`, 'INVALID_VALUE', 'asset must be a non-empty string of at most 12 characters');
  }
  if (value.issuer !== undefined && value.issuer !== null && typeof value.issuer !== 'string') {
    add(`${path}.issuer`, 'INVALID_TYPE', 'issuer must be a string or null');
  }
  if (!Number.isInteger(value.decimals) || (value.decimals as number) < 0 || (value.decimals as number) > 18) {
    add(`${path}.decimals`, 'INVALID_VALUE', 'decimals must be an integer between 0 and 18');
  }
}

function validateSources(value: unknown, add: AddError): void {
  if (!Array.isArray(value)) {
    add('$.eligibleSources', 'MISSING_FIELD', 'eligibleSources is required and must be an array');
    return;
  }
  if (value.length < 1 || value.length > 16) {
    add('$.eligibleSources', 'INVALID_VALUE', 'eligibleSources must contain between 1 and 16 entries');
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const path = `$.eligibleSources[${index}]`;
    if (!isObject(entry)) {
      add(path, 'INVALID_TYPE', 'eligible source must be an object');
      return;
    }
    if (typeof entry.source !== 'string' || !SOURCES.includes(entry.source)) {
      add(`${path}.source`, 'INVALID_VALUE', `source must be one of: ${SOURCES.join(', ')}`);
    } else if (seen.has(entry.source)) {
      add(`${path}.source`, 'INVALID_VALUE', `source "${entry.source}" is listed more than once`);
    } else {
      seen.add(entry.source);
    }
    if (!Number.isInteger(entry.weightBps) || (entry.weightBps as number) < 0 || (entry.weightBps as number) > 10000) {
      add(`${path}.weightBps`, 'INVALID_VALUE', 'weightBps must be an integer between 0 and 10000');
    }
    if (typeof entry.required !== 'boolean') {
      add(`${path}.required`, 'INVALID_TYPE', 'required must be a boolean');
    }
  });
}

function validateFreshness(value: unknown, add: AddError): void {
  if (!isObject(value)) {
    add('$.freshness', 'MISSING_FIELD', 'freshness is required and must be an object');
    return;
  }
  const heartbeat = value.heartbeatSeconds;
  const staleness = value.maxStalenessSeconds;
  if (!Number.isInteger(heartbeat) || (heartbeat as number) < 1) {
    add('$.freshness.heartbeatSeconds', 'INVALID_VALUE', 'heartbeatSeconds must be a positive integer');
  }
  if (!Number.isInteger(staleness) || (staleness as number) < 1) {
    add('$.freshness.maxStalenessSeconds', 'INVALID_VALUE', 'maxStalenessSeconds must be a positive integer');
  }
  if (Number.isInteger(heartbeat) && Number.isInteger(staleness) && (staleness as number) < (heartbeat as number)) {
    add('$.freshness.maxStalenessSeconds', 'INVALID_VALUE', 'maxStalenessSeconds must be greater than or equal to heartbeatSeconds');
  }
  if (
    value.deviationThresholdBps !== undefined &&
    (!Number.isInteger(value.deviationThresholdBps) ||
      (value.deviationThresholdBps as number) < 0 ||
      (value.deviationThresholdBps as number) > 10000)
  ) {
    add('$.freshness.deviationThresholdBps', 'INVALID_VALUE', 'deviationThresholdBps must be an integer between 0 and 10000');
  }
}

function validateOwnership(value: unknown, add: AddError): void {
  if (!isObject(value)) {
    add('$.ownership', 'MISSING_FIELD', 'ownership is required and must be an object');
    return;
  }
  for (const key of ['team', 'owner', 'oncall'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      add(`$.ownership.${key}`, 'MISSING_FIELD', `${key} is required and must be a non-empty string`);
    }
  }
  if (typeof value.owner === 'string' && !EMAIL.test(value.owner)) {
    add('$.ownership.owner', 'INVALID_VALUE', 'owner must be an email address');
  }
}

function validateLifecycle(value: unknown, feedId: unknown, add: AddError): void {
  if (!isObject(value)) {
    add('$.lifecycle', 'MISSING_FIELD', 'lifecycle is required and must be an object');
    return;
  }
  if (typeof value.state !== 'string' || !STATES.includes(value.state)) {
    add('$.lifecycle.state', 'INVALID_VALUE', `state must be one of: ${STATES.join(', ')}`);
  }
  if (typeof value.since !== 'string' || Number.isNaN(Date.parse(value.since))) {
    add('$.lifecycle.since', 'INVALID_VALUE', 'since must be an ISO-8601 timestamp');
  }
  if (value.successorFeedId !== undefined) {
    if (typeof value.successorFeedId !== 'string' || !FEED_ID.test(value.successorFeedId)) {
      add('$.lifecycle.successorFeedId', 'INVALID_VALUE', 'successorFeedId must be lower-case kebab-case');
    } else if (value.successorFeedId === feedId) {
      add('$.lifecycle.successorFeedId', 'INVALID_VALUE', 'successorFeedId must differ from feedId');
    }
  }
  if ((value.state === 'deprecated' || value.state === 'retired') && value.successorFeedId === undefined) {
    add('$.lifecycle.successorFeedId', 'MISSING_FIELD', `${value.state} feeds must name a successorFeedId`);
  }
}
