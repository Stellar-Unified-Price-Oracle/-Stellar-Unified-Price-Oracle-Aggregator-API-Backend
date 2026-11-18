import fs from 'fs';
import path from 'path';
import { config } from '../infrastructure/config';
import { encrypt, decrypt, isEncrypted, isEncryptionConfigured } from '../infrastructure/crypto';
import { logger } from '../observability/logger';
import {
  historyFileReadFailuresTotal,
  historyFileQuarantinesTotal,
  historyFileWriteFailuresTotal,
} from '../observability/metrics';

export interface HistoricalPriceEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

// HISTORY_DIR lets the integration-test orchestrator point both services at the
// same directory without a filesystem symlink. Falls back to the default
// relative path when the variable is absent so existing deployments are unaffected.
export const DATA_DIR = process.env.HISTORY_DIR
  ? path.resolve(process.env.HISTORY_DIR)
  : path.resolve(__dirname, '../../data');
export const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
export const HISTORY_FILE = (asset: string) => path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);

export type HistoryFailureReason = 'unreadable' | 'undecryptable' | 'malformed';

/**
 * Issue #589 — raised instead of silently returning an empty history when a
 * file exists but cannot be read, decrypted or parsed. `reason` lets callers
 * tell a key problem (`undecryptable`) from truncation (`malformed`) or an
 * I/O problem (`unreadable`).
 */
export class HistoryReadError extends Error {
  readonly name = 'HistoryReadError';
  readonly reason: HistoryFailureReason;
  readonly filePath: string;

  constructor(message: string, reason: HistoryFailureReason, filePath: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.reason = reason;
    this.filePath = filePath;
    Object.setPrototypeOf(this, HistoryReadError.prototype);
  }
}

/** Issue #589 — raised when an append could not be confirmed durable. */
export class HistoryWriteError extends Error {
  readonly name = 'HistoryWriteError';
  readonly filePath: string;

  constructor(message: string, filePath: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.filePath = filePath;
    Object.setPrototypeOf(this, HistoryWriteError.prototype);
  }
}

export type HistoryFileStatus =
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'ok'; entries: HistoricalPriceEntry[] }
  | { state: 'unreadable'; reason: HistoryFailureReason; error: HistoryReadError };

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Whether historical price files should be encrypted at rest (issue #41). */
export function historyEncryptionEnabled(): boolean {
  return config.security.encryption.encryptHistory && isEncryptionConfigured();
}

function describeCause(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyFailure(err: unknown): HistoryFailureReason {
  const message = describeCause(err);
  if (
    /No encryption key available|authentication tag|Malformed encrypted payload|Unsupported encryption/i.test(message)
  ) {
    return 'undecryptable';
  }
  if (err instanceof SyntaxError) return 'malformed';
  return 'unreadable';
}

function buildReadError(filePath: string, err: unknown): HistoryReadError {
  const reason = classifyFailure(err);
  return new HistoryReadError(
    `Failed to read history file ${filePath} (${reason}): ${describeCause(err)}`,
    reason,
    filePath,
    err,
  );
}

/**
 * Issue #589 — the single place that decides whether a history file is absent,
 * empty, readable or unreadable. Never rewrites or quarantines anything.
 */
export function readHistoryFileStatus(filePath: string): HistoryFileStatus {
  if (!fs.existsSync(filePath)) return { state: 'absent' };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const error = buildReadError(filePath, err);
    return { state: 'unreadable', reason: error.reason, error };
  }

  if (!raw.trim()) return { state: 'empty' };

  try {
    const contents = isEncrypted(raw) ? decrypt(raw) : raw;
    const parsed = JSON.parse(contents) as unknown;
    if (!Array.isArray(parsed)) {
      throw new SyntaxError('history file does not contain a JSON array');
    }
    return { state: 'ok', entries: parsed as HistoricalPriceEntry[] };
  } catch (err) {
    const error = buildReadError(filePath, err);
    return { state: 'unreadable', reason: error.reason, error };
  }
}

export function readHistoryFile(filePath: string): HistoricalPriceEntry[] {
  const status = readHistoryFileStatus(filePath);
  if (status.state === 'unreadable') throw status.error;
  if (status.state === 'ok') return status.entries;
  return [];
}

function fsyncBestEffort(tmpPath: string): void {
  try {
    const fd = fs.openSync(tmpPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best effort — rename below still keeps the file consistent */
  }
}

function writePayloadAtomically(filePath: string, payload: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, payload);
    fsyncBestEffort(tmpPath);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* leave nothing behind */
    }
    throw err;
  }
}

export function writeHistoryFile(filePath: string, history: HistoricalPriceEntry[]): void {
  const serialized = JSON.stringify(history);
  const payload = historyEncryptionEnabled() ? encrypt(serialized) : serialized;
  writePayloadAtomically(filePath, payload);
}

/**
 * Issue #589 — read the file back and compare it to what was written so an
 * append is only treated as durable once it is proven to be on disk.
 */
export function verifyHistoryFile(filePath: string, expected: HistoricalPriceEntry[]): void {
  const status = readHistoryFileStatus(filePath);
  if (status.state !== 'ok') {
    const detail = status.state === 'unreadable' ? status.error.message : `file is ${status.state}`;
    throw new HistoryWriteError(
      `Post-write verification failed for ${filePath}: ${detail}`,
      filePath,
      status.state === 'unreadable' ? status.error : undefined,
    );
  }
  if (
    status.entries.length !== expected.length ||
    JSON.stringify(status.entries) !== JSON.stringify(expected)
  ) {
    throw new HistoryWriteError(
      `Post-write verification failed for ${filePath}: expected ${expected.length} entries, read ${status.entries.length}`,
      filePath,
    );
  }
}

/**
 * Move a file that failed to parse out of the active history namespace so the
 * next append cannot destroy it. Returns the quarantine path.
 */
function quarantineHistoryFile(filePath: string, asset: string, reason: HistoryFailureReason): string {
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(QUARANTINE_DIR, `history-${asset.toLowerCase()}-${reason}-${stamp}.json`);
  fs.renameSync(filePath, target);
  return target;
}

function recordIntegrityFailure(
  operation: 'read' | 'quarantine' | 'write',
  asset: string,
  reason: HistoryFailureReason,
  filePath: string,
): void {
  if (operation === 'read') historyFileReadFailuresTotal.inc({ asset: asset.toLowerCase(), reason });
  if (operation === 'quarantine') historyFileQuarantinesTotal.inc({ asset: asset.toLowerCase(), reason });
  if (operation === 'write') historyFileWriteFailuresTotal.inc({ asset: asset.toLowerCase(), reason });

  logger.error('History file integrity failure', {
    operation,
    asset,
    reason,
    filePath,
    severity: 'error',
    alert: 'history-file-integrity',
  });
}

/**
 * Drop entries older than the retention window, then keep only the newest
 * maxEntries (issue #214). Entry timestamps are Unix seconds.
 */
function pruneHistory(history: HistoricalPriceEntry[]): HistoricalPriceEntry[] {
  const { maxEntries, retentionSeconds } = config.history;
  let pruned = history;

  if (retentionSeconds > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;
    pruned = pruned.filter((h) => h.timestamp >= cutoff);
  }

  return maxEntries > 0 && pruned.length > maxEntries ? pruned.slice(-maxEntries) : pruned;
}

export function appendHistoricalPrice(
  asset: string,
  price: string,
  decimals: number,
  source: string,
  timestamp: number,
): void {
  ensureDataDir();
  const filePath = HISTORY_FILE(asset);
  const entry: HistoricalPriceEntry = { price, decimals, source, timestamp };

  const status = readHistoryFileStatus(filePath);
  let history: HistoricalPriceEntry[];

  if (status.state === 'unreadable') {
    recordIntegrityFailure('read', asset, status.reason, filePath);
    let quarantinePath: string;
    try {
      quarantinePath = quarantineHistoryFile(filePath, asset, status.reason);
    } catch (err) {
      recordIntegrityFailure('write', asset, status.reason, filePath);
      throw new HistoryReadError(
        `Refusing to overwrite unreadable history file ${filePath} and quarantine failed: ${describeCause(err)}`,
        status.reason,
        filePath,
        err,
      );
    }
    recordIntegrityFailure('quarantine', asset, status.reason, quarantinePath);
    logger.error('Quarantined unreadable history file; starting a new file from the recovered entry', {
      asset,
      reason: status.reason,
      originalPath: filePath,
      quarantinePath,
      errorMessage: status.error.message,
      severity: 'error',
      alert: 'history-file-integrity',
    });
    history = [];
  } else if (status.state === 'ok') {
    history = status.entries;
  } else {
    history = [];
  }

  history.push(entry);
  const pruned = pruneHistory(history);

  try {
    writeHistoryFile(filePath, pruned);
    verifyHistoryFile(filePath, pruned);
  } catch (err) {
    recordIntegrityFailure('write', asset, 'unreadable', filePath);
    throw err instanceof HistoryWriteError || err instanceof HistoryReadError
      ? err
      : new HistoryWriteError(
          `Failed to append to history file ${filePath}: ${describeCause(err)}`,
          filePath,
          err,
        );
  }
}

/**
 * Issue #589 — absent and empty histories are legitimate empty results;
 * an unreadable file throws instead of being reported as "no data".
 */
export function getHistoricalPrices(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): HistoricalPriceEntry[] {
  const filePath = HISTORY_FILE(asset);
  let history = readHistoryFile(filePath);
  if (from) history = history.filter((h) => h.timestamp >= from);
  if (to) history = history.filter((h) => h.timestamp <= to);
  return history.slice(-limit);
}

/** A single missing cadence slot inside a [from, to] window. */
export interface HistoryGap {
  /** Inclusive start of the missing slot (Unix seconds). */
  start: number;
  /** Exclusive end of the missing slot (Unix seconds). */
  end: number;
  /** Number of expected cadence slots that are missing in this gap. */
  missingSlots: number;
}

export interface HistoryGapReport {
  asset: string;
  from: number;
  to: number;
  /** Cadence (seconds) used to compute expected slots. */
  cadenceSeconds: number;
  /** Expected slot timestamps that had no history entry. */
  missing: number[];
  /** Contiguous runs of missing slots, ordered by start. */
  gaps: HistoryGap[];
  /** Largest gap length in seconds (0 when nothing is missing). */
  largestGapSeconds: number;
  /** True when no gap exceeds `thresholdSeconds`. */
  ok: boolean;
  /** Threshold (seconds) used to decide `ok`. */
  thresholdSeconds: number;
}

export interface HistoryGapOptions {
  /** Cadence of expected history entries in seconds. Defaults to `config.history.intervalSeconds`. */
  cadenceSeconds?: number;
  /** Gap size (seconds) that counts as an alert. Defaults to `config.history.gapAlertSeconds`. */
  thresholdSeconds?: number;
  /**
   * Pre-loaded entries. When omitted the history file for `asset` is read via
   * `getHistoricalPrices`. Callers backed by another store (e.g. the DB) can
   * pass their own entries so the detector and backfill share one definition.
   */
  entries?: HistoricalPriceEntry[];
}

function resolveCadenceSeconds(override?: number): number {
  const candidate = override ?? (config.history as { intervalSeconds?: number }).intervalSeconds;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return 60;
}

function resolveGapThresholdSeconds(override?: number): number {
  const candidate = override ?? (config.history as { gapAlertSeconds?: number }).gapAlertSeconds;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return 900;
}

/**
 * Issue #889/#890/#893 — the single definition of a history gap. Given an
 * asset and an inclusive [from, to] window, enumerate the expected cadence
 * slots and report which ones have no history entry. The backfill script and
 * the scheduled gap detector both call this so they cannot drift apart.
 */
export function findHistoryGaps(
  asset: string,
  from: number,
  to: number,
  options: HistoryGapOptions = {},
): HistoryGapReport {
  const cadenceSeconds = resolveCadenceSeconds(options.cadenceSeconds);
  const thresholdSeconds = resolveGapThresholdSeconds(options.thresholdSeconds);

  const start = Math.floor(from);
  const end = Math.floor(to);
  const report: HistoryGapReport = {
    asset,
    from: start,
    to: end,
    cadenceSeconds,
    missing: [],
    gaps: [],
    largestGapSeconds: 0,
    ok: true,
    thresholdSeconds,
  };

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return report;

  const entries = options.entries ?? getHistoricalPrices(asset, start, end, Number.MAX_SAFE_INTEGER);
  const present = new Set<number>();
  for (const entry of entries) {
    if (entry.timestamp >= start && entry.timestamp <= end) present.add(entry.timestamp);
  }

  // Align expected slots to the cadence grid so detector and backfill agree on
  // exactly which timestamps should exist.
  const firstSlot = Math.ceil(start / cadenceSeconds) * cadenceSeconds;
  for (let slot = firstSlot; slot <= end; slot += cadenceSeconds) {
    if (!present.has(slot)) report.missing.push(slot);
  }

  let current: HistoryGap | undefined;
  for (const slot of report.missing) {
    if (current && current.end === slot) {
      current.end = slot + cadenceSeconds;
      current.missingSlots += 1;
    } else {
      current = { start: slot, end: slot + cadenceSeconds, missingSlots: 1 };
      report.gaps.push(current);
    }
  }

  for (const gap of report.gaps) {
    const length = gap.end - gap.start;
    if (length > report.largestGapSeconds) report.largestGapSeconds = length;
  }

  report.ok = report.largestGapSeconds <= thresholdSeconds;
  return report;
}
