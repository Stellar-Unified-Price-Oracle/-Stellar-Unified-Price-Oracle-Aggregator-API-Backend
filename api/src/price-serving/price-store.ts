import fs from 'fs';
import path from 'path';
import type { ApiPrice, HistoricalPriceEntry } from '@stellar-oracle/types';
import { DatabaseClient, type PriceHistory } from '../infrastructure/database';
import { decrypt, encrypt, isEncrypted, isEncryptionConfigured } from '../governance/crypto';
import { decodeCursor } from './pagination';
import { AppError } from '../infrastructure/app-error';
import { ErrorCode } from '../infrastructure/catalog';
import { logger } from '../observability/logger';
import { historyFileReadFailuresTotal } from '../observability/metrics';
import {
  CONSISTENCY_OBJECTIVES,
  evaluateObjective,
  type ConsistencyObjectiveName,
  type ObjectiveEvaluation,
} from '../governance/consistency-objectives';

// HISTORY_DIR lets the integration-test orchestrator point both services at the
// same directory without a filesystem symlink. Falls back to the default
// relative path when the variable is absent so existing deployments are unaffected.
const DATA_DIR = process.env.HISTORY_DIR
  ? path.resolve(process.env.HISTORY_DIR)
  : path.resolve(__dirname, '../../data');
const HISTORY_FILE = (asset: string) => path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);
let db: DatabaseClient | null = null;

export const SANDBOX_ASSETS = ['XLM', 'USDC', 'BTC', 'ETH', 'USDT'] as const;

export type HistoryFailureReason = 'unreadable' | 'undecryptable' | 'malformed';

/**
 * Issue #746 — consumer-visible consistency metadata attached to every
 * price-serving payload. `objective` names the data-product objective that
 * governs the read, `maxStalenessSeconds` is its freshness bound and
 * `observedAgeSeconds` is how old the freshest returned record is.
 */
export interface ConsistencyMetadata {
  objective: ConsistencyObjectiveName;
  maxStalenessSeconds: number;
  observedAgeSeconds: number | null;
  withinObjective: boolean;
  evaluatedAt: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toConsistencyMetadata(evaluation: ObjectiveEvaluation): ConsistencyMetadata {
  return {
    objective: evaluation.objective,
    maxStalenessSeconds: evaluation.maxStalenessSeconds,
    observedAgeSeconds: evaluation.observedAgeSeconds,
    withinObjective: evaluation.withinObjective,
    evaluatedAt: evaluation.evaluatedAt,
  };
}

/** Build metadata for a read whose freshest record is `latestTimestamp`. */
export function priceConsistencyMetadata(
  objective: ConsistencyObjectiveName,
  latestTimestamp: number | null | undefined,
): ConsistencyMetadata {
  return toConsistencyMetadata(evaluateObjective(objective, latestTimestamp, nowSeconds()));
}

function describeCause(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyFailure(err: unknown): HistoryFailureReason {
  const message = describeCause(err);
  if (/No encryption key available|authentication tag|Malformed encrypted payload|Unsupported encryption/i.test(message)) {
    return 'undecryptable';
  }
  if (err instanceof SyntaxError) return 'malformed';
  return 'unreadable';
}

/** Issue #589 — surfaces a stored-but-unreadable history file as a typed fault. */
function toHistoryReadError(filePath: string, asset: string, err: unknown): AppError {
  const reason = classifyFailure(err);
  historyFileReadFailuresTotal.inc({ asset: asset.toLowerCase(), reason });
  logger.error('History file read failure', {
    asset,
    reason,
    filePath,
    message: describeCause(err),
    severity: 'error',
    alert: 'history-file-integrity',
  });
  return new AppError(
    ErrorCode.DATA_INTEGRITY_ERROR,
    `History file for ${asset} is ${reason}: ${describeCause(err)}`,
    { asset, reason, filePath },
  );
}

/** Replace file-backed data with deterministic, recent fixtures for sandbox resets. */
export function resetSandboxData(now = Math.floor(Date.now() / 1000)): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prices: Record<string, string> = {
    XLM: '0.1200000', USDC: '1.0000000', BTC: '68000.0000000',
    ETH: '3500.0000000', USDT: '1.0000000',
  };
  for (const asset of SANDBOX_ASSETS) {
    const history: HistoricalPriceEntry[] = Array.from({ length: 10 }, (_, index) => ({
      price: prices[asset], decimals: 7, source: 'sandbox-fixture', timestamp: now - (9 - index) * 60,
    }));
    const serialized = JSON.stringify(history, null, 2);
    fs.writeFileSync(HISTORY_FILE(asset), isEncryptionConfigured() ? encrypt(serialized) : serialized);
  }
}

/** Read and parse a history file, transparently decrypting if encrypted at rest. */
function readHistoryFile(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return [];
  const contents = isEncrypted(raw) ? decrypt(raw) : raw;
  const parsed = JSON.parse(contents) as unknown;
  if (!Array.isArray(parsed)) {
    throw new SyntaxError('history file does not contain a JSON array');
  }
  return parsed;
}

export function setDatabase(database: DatabaseClient | null): void {
  db = database;
}

/**
 * Issue #746 — expose the objective registry so catalog and analytics reads
 * (and their consumers) can attach the same consumer-visible semantics.
 */
export function consistencyObjectiveFor(
  name: ConsistencyObjectiveName,
): ConsistencyMetadata {
  const objective = CONSISTENCY_OBJECTIVES[name];
  return {
    objective: objective.name,
    maxStalenessSeconds: objective.maxStalenessSeconds,
    observedAgeSeconds: null,
    withinObjective: true,
    evaluatedAt: nowSeconds(),
  };
}

export async function readAssetPrices(): Promise<ApiPrice[]> {
  if (db && db.isInitialized()) {
    try {
      const prices = await db.getAllLatestPrices();
      return prices.map((p: PriceHistory) => ({
        asset: p.asset,
        price: p.price,
        decimals: p.decimals,
        source: p.source,
        timestamp: p.timestamp,
        consistency: priceConsistencyMetadata('live-prices', p.timestamp),
      }));
    } catch (err) {
      console.error('Failed to read from database, falling back to files', err);
    }
  }

  const dir = DATA_DIR;
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.startsWith('history-'));
  const assets = new Map<string, ApiPrice>();

  for (const file of files) {
    try {
      const asset = file.replace('history-', '').replace('.json', '').toUpperCase();
      const data = readHistoryFile(path.join(dir, file));
      if (data.length > 0) {
        const latest = data[data.length - 1] as Record<string, unknown>;
        assets.set(asset, {
          asset,
          price: latest.price as string,
          decimals: latest.decimals as number,
          source: latest.source as string,
          timestamp: latest.timestamp as number,
          consistency: priceConsistencyMetadata('live-prices', latest.timestamp as number),
        });
      }
    } catch (err) {
      logger.error('Skipping unreadable history file while listing assets', {
        file,
        reason: classifyFailure(err),
        message: describeCause(err),
        severity: 'error',
        alert: 'history-file-integrity',
      });
      historyFileReadFailuresTotal.inc({ asset: file, reason: classifyFailure(err) });
    }
  }

  return Array.from(assets.values());
}

export async function readPriceHistory(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): Promise<HistoricalPriceEntry[]> {
  if (from !== undefined && to !== undefined && from > to) return [];

  if (db && db.isInitialized()) {
    try {
      const history = await db.getHistoricalPrices(asset, from, to, limit);
      return withHistoryConsistency(history.map((h: PriceHistory) => ({
        price: h.price,
        decimals: h.decimals,
        source: h.source,
        timestamp: h.timestamp,
      })));
    } catch (err) {
      console.error('Failed to read from database, falling back to files', err);
    }
  }

  const filePath = path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);
  if (!fs.existsSync(filePath)) return [];

  try {
    let history = readHistoryFile(filePath) as HistoricalPriceEntry[];
    if (from) history = history.filter((h) => h.timestamp >= from);
    if (to) history = history.filter((h) => h.timestamp <= to);
    return withHistoryConsistency(history.slice(-limit));
  } catch (err) {
    throw toHistoryReadError(filePath, asset, err);
  }
}

/**
 * Attach the `history` data-product objective to a batch of history entries.
 * The objective is evaluated against the freshest entry in the batch so a
 * consumer can tell whether the returned window satisfies the freshness bound.
 */
function withHistoryConsistency(entries: HistoricalPriceEntry[]): HistoricalPriceEntry[] {
  const latest = entries.reduce<number | null>(
    (acc, entry) => (acc === null || entry.timestamp > acc ? entry.timestamp : acc),
    null,
  );
  const consistency = priceConsistencyMetadata('history', latest);
  return entries.map((entry) => ({ ...entry, consistency }));
}

/**
 * Cursor-based history fetch. The cursor encodes the timestamp of the last
 * returned record; the next page starts strictly after that timestamp.
 * Results are sorted ascending by timestamp.
 */
export async function readPriceHistoryCursor(
  asset: string,
  cursor: string | undefined,
  limit: number,
  to?: number,
): Promise<HistoricalPriceEntry[]> {
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded && to !== undefined && decoded.ts > to) return [];
  }

  let afterTs: number | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    afterTs = decoded?.ts;
  }

  if (db && db.isInitialized()) {
    try {
      const from = afterTs !== undefined ? afterTs + 1 : undefined;
      const history = await db.getHistoricalPrices(asset, from, to, limit);
      return withHistoryConsistency(history.map((h: PriceHistory) => ({
        price: h.price,
        decimals: h.decimals,
        source: h.source,
        timestamp: h.timestamp,
      })));
    } catch (err) {
      console.error('Failed to read from database for cursor query, falling back to files', err);
    }
  }

  const filePath = path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);
  if (!fs.existsSync(filePath)) return [];

  try {
    let history = readHistoryFile(filePath) as HistoricalPriceEntry[];
    history.sort((a, b) => a.timestamp - b.timestamp);
    if (afterTs !== undefined) history = history.filter((h) => h.timestamp > afterTs!);
    if (to !== undefined) history = history.filter((h) => h.timestamp <= to);
    return withHistoryConsistency(history.slice(0, limit + 1));
  } catch (err) {
    throw toHistoryReadError(filePath, asset, err);
  }
}
