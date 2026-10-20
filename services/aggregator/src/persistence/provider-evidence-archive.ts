import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { OracleSourceName } from '../infrastructure/types';
import { logger } from '../observability/logger';

/**
 * Issue #686 — Privacy- and retention-controlled provider evidence archive.
 *
 * Selected raw provider responses are archived with timestamps and correlation
 * IDs for reproducible incident analysis. Archiving is opt-in (off by default),
 * writes are bounded by a max-entry count and a retention TTL, and sensitive
 * request/response fields are redacted before anything touches disk so
 * credentials never leak into the archive.
 */

export interface ProviderEvidenceRecord {
  correlationId: string;
  source: OracleSourceName;
  asset: string;
  /** Unix seconds when the evidence was archived. */
  archivedAt: number;
  /** The provider's own observation time, when reported. */
  providerObservedAt: number | null;
  requestUrl: string;
  requestMethod: string;
  responseStatus: number | null;
  /** Redacted response body. */
  responseBody: unknown;
  /** Field paths that were redacted, for audit transparency. */
  redactedFields: string[];
  /** Unix seconds after which this record is eligible for pruning. */
  ttlExpiresAt: number;
}

export interface ProviderEvidenceArchiveOptions {
  /** Archiving is disabled unless explicitly enabled. */
  enabled: boolean;
  /** Directory under which evidence files are written. */
  dir: string;
  /** Maximum number of evidence files to keep; oldest are pruned first. */
  maxEntries: number;
  /** Retention window in days; records older than this are pruned. */
  retentionDays: number;
  /** Request/response field paths (case-insensitive substrings) to redact. */
  redactKeys: string[];
}

/** Default field paths treated as sensitive and redacted from archived evidence. */
const DEFAULT_REDACT_KEYS = [
  'apikey',
  'api_key',
  'authorization',
  'secret',
  'password',
  'credential',
  'token',
  'private',
];

/**
 * Redacts sensitive values from a JSON-compatible value, recording the field
 * paths that were touched so operators can see what was withheld without
 * seeing the secrets themselves.
 */
function redactValue(
  value: unknown,
  path: string,
  redactKeys: string[],
  redactedFields: string[],
): unknown {
  const key = path.split('.').pop() ?? '';
  const isSensitive = redactKeys.some((rk) => key.toLowerCase().includes(rk));

  if (isSensitive) {
    redactedFields.push(path);
    return '***REDACTED***';
  }

  if (Array.isArray(value)) {
    return value.map((entry, idx) =>
      redactValue(entry, `${path}[${idx}]`, redactKeys, redactedFields),
    );
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, `${path}.${k}`, redactKeys, redactedFields);
    }
    return out;
  }

  return value;
}

function redactObject(
  value: unknown,
  redactKeys: string[],
): { redacted: unknown; redactedFields: string[] } {
  const redactedFields: string[] = [];
  return {
    redacted: redactValue(value, '$', redactKeys, redactedFields),
    redactedFields,
  };
}

function evidenceFileName(record: ProviderEvidenceRecord): string {
  const safeSource = String(record.source).replace(/[^a-z0-9_-]/gi, '_');
  const safeAsset = String(record.asset).replace(/[^a-z0-9_-]/gi, '_');
  return `${record.archivedAt}-${record.correlationId}-${safeSource}-${safeAsset}.json`;
}

/**
 * Archives raw provider evidence to disk. Each record is its own JSON file so
 * retention pruning is a simple directory scan and individual records can be
 * pulled for incident analysis without rewriting the whole archive.
 */
export class ProviderEvidenceArchive {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly retentionDays: number;
  private readonly redactKeys: string[];

  constructor(options: ProviderEvidenceArchiveOptions) {
    this.enabled = options.enabled;
    this.dir = options.dir;
    this.maxEntries = options.maxEntries;
    this.retentionDays = options.retentionDays;
    this.redactKeys = options.redactKeys;

    if (this.enabled && !existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** No-op when archiving is disabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Records one provider response as evidence. Returns the file path when
   * written, or null when archiving is disabled or the write fails.
   */
  record(input: Omit<ProviderEvidenceRecord, 'ttlExpiresAt' | 'archivedAt' | 'requestUrl' | 'requestMethod' | 'responseStatus' | 'providerObservedAt' | 'redactedFields'> & {
    archivedAt?: number;
    providerObservedAt?: number | null;
    requestUrl?: string;
    requestMethod?: string;
    responseStatus?: number | null;
  }): string | null {
    if (!this.enabled) return null;

    const archivedAt = input.archivedAt ?? Math.floor(Date.now() / 1000);
    const correlationId = input.correlationId || randomUUID();
    const ttlExpiresAt = archivedAt + this.retentionDays * 86_400;

    const { redacted: responseBody, redactedFields } = redactObject(
      input.responseBody ?? null,
      this.redactKeys,
    );

    const record: ProviderEvidenceRecord = {
      correlationId,
      source: input.source,
      asset: input.asset,
      archivedAt,
      providerObservedAt: input.providerObservedAt ?? null,
      requestUrl: this.redactUrl(input.requestUrl ?? ''),
      requestMethod: input.requestMethod ?? 'GET',
      responseStatus: input.responseStatus ?? null,
      responseBody,
      redactedFields,
      ttlExpiresAt,
    };

    try {
      const path = join(this.dir, evidenceFileName(record));
      writeFileSync(path, JSON.stringify(record, null, 2));
      this.prune();
      return path;
    } catch (err) {
      logger.error('[ProviderEvidenceArchive] Failed to write evidence record', err);
      return null;
    }
  }

  /** Redact any embedded credentials from a request URL before archiving. */
  private redactUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password || parsed.username) {
        parsed.password = '***REDACTED***';
        parsed.username = '***REDACTED***';
      }
      // Redact sensitive query parameters (api_key, authorization, etc.).
      for (const key of parsed.searchParams.keys()) {
        if (this.redactKeys.some((rk) => key.toLowerCase().includes(rk))) {
          parsed.searchParams.set(key, '***REDACTED***');
        }
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  /**
   * Prunes expired and over-limit evidence files. Expired (past ttlExpiresAt)
   * records are removed first; if more than maxEntries remain, the oldest are
   * removed until within the limit. Returns the number of files removed.
   */
  prune(): number {
    if (!this.enabled) return 0;
    if (!existsSync(this.dir)) return 0;

    const now = Math.floor(Date.now() / 1000);
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));

    let removed = 0;
    const survivors: Array<{ name: string; archivedAt: number }> = [];

    for (const name of files) {
      const full = join(this.dir, name);
      try {
        const content = JSON.parse(readFileSync(full, 'utf-8')) as ProviderEvidenceRecord;
        if (content.ttlExpiresAt && content.ttlExpiresAt <= now) {
          unlinkSync(full);
          removed++;
        } else {
          survivors.push({ name, archivedAt: content.archivedAt ?? 0 });
        }
      } catch {
        // Unparseable files are not auto-removed; keep them by archivedAt 0.
        survivors.push({ name, archivedAt: 0 });
      }
    }

    // Remove the oldest archived records first until within the entry cap.
    if (survivors.length > this.maxEntries) {
      survivors.sort((a, b) => a.archivedAt - b.archivedAt);
      const toRemove = survivors.slice(0, survivors.length - this.maxEntries);
      for (const entry of toRemove) {
        try {
          unlinkSync(join(this.dir, entry.name));
          removed++;
        } catch {
          // ignore
        }
      }
    }

    return removed;
  }
}

/**
 * Singleton archive. Disabled by default; enable via
 * `PROVIDER_EVIDENCE_ARCHIVE_ENABLED=true` and point at a private directory.
 */
export const providerEvidenceArchive = new ProviderEvidenceArchive({
  enabled: process.env.PROVIDER_EVIDENCE_ARCHIVE_ENABLED === 'true',
  dir: process.env.PROVIDER_EVIDENCE_ARCHIVE_DIR || './data/provider-evidence',
  maxEntries: parseInt(process.env.PROVIDER_EVIDENCE_ARCHIVE_MAX_ENTRIES || '10000', 10),
  retentionDays: parseInt(process.env.PROVIDER_EVIDENCE_ARCHIVE_RETENTION_DAYS || '30', 10),
  redactKeys: DEFAULT_REDACT_KEYS,
});
