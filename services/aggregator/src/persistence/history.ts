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

const WRITE_MAX_ATTEMPTS = 3;
const WRITE_RETRY_BASE_DELAY_MS = 50;

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Issue #881-#884 — a transient filesystem error (EBUSY, EAGAIN, EPERM,
 * ENOSPC that clears, etc.) must not silently drop an append and open a
 * >900s gap. Retry the write+verify cycle a bounded number of times with
 * exponential backoff before surfacing a HistoryWriteError.
 */
function writeAndVerifyWithRetry(
  filePath: string,
  asset: string,
  entry: HistoricalPriceEntry,
  history: HistoricalPriceEntry[],
): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      writeHistoryFile(filePath, history);
      verifyHistoryFile(filePath, history);
      return;
    } catch (err) {
      lastError = err;
      const willRetry = attempt < WRITE_MAX_ATTEMPTS;
      logger.warn('History append attempt failed', {
        asset,
        timestamp: entry.timestamp,
        attempt,
        maxAttempts: WRITE_MAX_ATTEMPTS,
        willRetry,
        filePath,
        errorMessage: describeCause(err),
        severity: willRetry ? 'warn' : 'error',
        alert: willRetry ? undefined : 'history-file-integrity',
      });
      if (willRetry) {
        sleepSync(WRITE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
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
=======

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

  // Surface missed ticks at the source: if the newest pre-existing entry is
  // older than the expected cadence, the gap detector would only notice much
  // later. Log it here so it is visible in aggregator logs immediately.
  const previous = history.length > 0 ? history[history.length - 1] : undefined;
  if (previous && entry.timestamp > previous.timestamp) {
    const elapsedSeconds = entry.timestamp - previous.timestamp;
    const expectedInterval = config.history.expectedIntervalSeconds;
    if (expectedInterval > 0 && elapsedSeconds > expectedInterval) {
      logger.warn('History gap detected while appending price', {
        asset,
        lastTimestamp: previous.timestamp,
        elapsedSeconds,
        expectedIntervalSeconds: expectedInterval,
        severity: 'warn',
        alert: 'history-gap',
      });
    }
  }

  history.push(entry);
  const pruned = pruneHistory(history);

  try {
    writeAndVerifyWithRetry(filePath, asset, entry, pruned);
  } catch (err) {
    recordIntegrityFailure('write', asset, 'unreadable', filePath);
    logger.error('History append failed after retries; entry was not persisted', {
      asset,
      timestamp: entry.timestamp,
      filePath,
      errorMessage: describeCause(err),
      severity: 'error',
      alert: 'history-file-integrity',
    });
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
