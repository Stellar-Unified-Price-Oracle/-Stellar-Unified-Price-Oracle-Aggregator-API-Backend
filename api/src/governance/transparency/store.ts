import fs from 'fs';
import path from 'path';
import type { ZodType, ZodTypeDef } from 'zod';

export type TransparencyArtifactName =
  | 'governance-snapshot.json'
  | 'treasury-snapshot.json'
  | 'release-review.json'
  | 'rehearsal-report.json';

export type TransparencyStoreErrorCode = 'not_found' | 'invalid' | 'unreadable';

/**
 * Typed failure for transparency artifacts. Routes map `not_found` to 404 and
 * `invalid` to 422 so a malformed nightly snapshot never masquerades as a 500.
 */
export class TransparencyStoreError extends Error {
  constructor(
    public readonly code: TransparencyStoreErrorCode,
    message: string,
    public readonly artifactPath?: string,
  ) {
    super(message);
    this.name = 'TransparencyStoreError';
  }
}

export function transparencyDir(): string {
  return process.env.GOVERNANCE_TRANSPARENCY_DIR
    ? path.resolve(process.env.GOVERNANCE_TRANSPARENCY_DIR)
    : path.resolve(__dirname, '../../../data/governance');
}

export interface LoadedArtifact<T> {
  data: T;
  path: string;
  modifiedAt: string | null;
}

function describeIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function readArtifact<T>(
  name: TransparencyArtifactName,
  schema: ZodType<T, ZodTypeDef, any>,
): LoadedArtifact<T> {
  const artifactPath = path.join(transparencyDir(), name);

  let raw: string;
  try {
    raw = fs.readFileSync(artifactPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new TransparencyStoreError('not_found', `${name} has not been published yet`, artifactPath);
    }
    throw new TransparencyStoreError(
      'unreadable',
      `${name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      artifactPath,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new TransparencyStoreError(
      'invalid',
      `${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      artifactPath,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new TransparencyStoreError('invalid', `${name} failed validation: ${describeIssues(result.error)}`, artifactPath);
  }

  let modifiedAt: string | null = null;
  try {
    modifiedAt = fs.statSync(artifactPath).mtime.toISOString();
  } catch {
    modifiedAt = null;
  }

  return { data: result.data, path: artifactPath, modifiedAt };
}

export function writeArtifact(name: TransparencyArtifactName, payload: unknown): string {
  const dir = transparencyDir();
  fs.mkdirSync(dir, { recursive: true });
  const artifactPath = path.join(dir, name);
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  return artifactPath;
}

export type FreshnessStatus = 'fresh' | 'stale';

export interface Freshness {
  asOf: string;
  ageHours: number;
  staleAfterHours: number;
  nextExpectedAt: string;
  status: FreshnessStatus;
}

/**
 * A snapshot is stale once it is older than 1.5x its documented update cadence.
 * The grace period absorbs a publish job that runs a little late without
 * paging, while still failing loudly if the publisher has stopped entirely.
 */
export function describeFreshness(asOf: string, cadenceHours: number, now: Date = new Date()): Freshness {
  const asOfMs = Date.parse(asOf);
  const ageHours = Math.max(0, (now.getTime() - asOfMs) / 3_600_000);
  const staleAfterHours = cadenceHours * 1.5;
  return {
    asOf,
    ageHours: Math.round(ageHours * 100) / 100,
    staleAfterHours,
    nextExpectedAt: new Date(asOfMs + cadenceHours * 3_600_000).toISOString(),
    status: ageHours > staleAfterHours ? 'stale' : 'fresh',
  };
}
