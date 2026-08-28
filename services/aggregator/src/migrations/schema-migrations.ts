import crypto from 'crypto';

export type MigrationKind = 'add-field' | 'remove-field' | 'rename-field' | 'change-type' | 'restructure';

export interface SchemaRecord {
  schema_version: number;
  [key: string]: unknown;
}

export interface MigrationScript {
  version: number;
  description: string;
  kind: MigrationKind;
  up: (record: SchemaRecord) => SchemaRecord;
  down: (record: SchemaRecord) => SchemaRecord;
  compatible: (record: SchemaRecord) => boolean;
}

export interface MigrationGuardrails {
  maxErrorRate: number;
  maxP99LatencyIncreasePct: number;
  requireIntegrityMatch: boolean;
}

export interface MigrationPlan {
  currentVersion: number;
  targetVersion: number;
  darkReadHours: number;
  guardrails: MigrationGuardrails;
  scripts: MigrationScript[];
}

export const DEFAULT_MIGRATION_GUARDRAILS: MigrationGuardrails = {
  maxErrorRate: 0.01,
  maxP99LatencyIncreasePct: 10,
  requireIntegrityMatch: true,
};

export function migrateRecord(record: SchemaRecord, scripts: MigrationScript[]): SchemaRecord {
  return scripts.reduce((next, script) => script.up(next), record);
}

export function rollbackRecord(record: SchemaRecord, scripts: MigrationScript[]): SchemaRecord {
  return [...scripts].reverse().reduce((next, script) => script.down(next), record);
}

export function darkReadCompare(
  legacy: SchemaRecord[],
  candidate: SchemaRecord[],
): { matched: boolean; mismatches: number } {
  let mismatches = 0;
  for (let index = 0; index < Math.max(legacy.length, candidate.length); index++) {
    if (JSON.stringify(legacy[index] ?? null) !== JSON.stringify(candidate[index] ?? null)) mismatches++;
  }
  return { matched: mismatches === 0, mismatches };
}

export function checksumRecords(records: SchemaRecord[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(records.map((record) => ({ ...record, schema_version: undefined }))))
    .digest('hex');
}

export function shouldRollback(input: {
  errorRate: number;
  p99LatencyIncreasePct: number;
  integrityMatched: boolean;
  guardrails?: MigrationGuardrails;
}): boolean {
  const guardrails = input.guardrails ?? DEFAULT_MIGRATION_GUARDRAILS;
  return input.errorRate > guardrails.maxErrorRate
    || input.p99LatencyIncreasePct > guardrails.maxP99LatencyIncreasePct
    || (guardrails.requireIntegrityMatch && !input.integrityMatched);
}

export function createMigrationPlan(
  currentVersion: number,
  targetVersion: number,
  scripts: MigrationScript[],
): MigrationPlan {
  return {
    currentVersion,
    targetVersion,
    darkReadHours: Number(process.env.SCHEMA_DARK_READ_HOURS || 24),
    guardrails: DEFAULT_MIGRATION_GUARDRAILS,
    scripts: scripts
      .filter((script) => script.version > currentVersion && script.version <= targetVersion)
      .sort((a, b) => a.version - b.version),
  };
}
