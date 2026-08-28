import fs from 'fs';
import path from 'path';
import { SourceHealthStatus } from '../infrastructure/types';
import { config } from '../infrastructure/config';
import { encrypt, decrypt, isEncrypted } from '../infrastructure/crypto';
import { ensureDataDir, historyEncryptionEnabled } from './history';

const DATA_DIR = path.resolve(__dirname, '../../data');
const UPTIME_FILE = (source: string) => path.join(DATA_DIR, `uptime-${source.toLowerCase()}.json`);

export interface UptimeSnapshot {
  timestamp: number;
  healthy: boolean;
  uptimePercent: number;
  totalRequests: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastSuccess: number | null;
  lastFailure: number | null;
}

function uptimeEncryptionEnabled(): boolean {
  return historyEncryptionEnabled();
}

function readUptimeFile(filePath: string): UptimeSnapshot[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw) return [];
  const contents = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(contents);
}

function writeUptimeFile(filePath: string, snapshots: UptimeSnapshot[]): void {
  const serialized = JSON.stringify(snapshots);
  const payload = uptimeEncryptionEnabled() ? encrypt(serialized) : serialized;
  fs.writeFileSync(filePath, payload);
}

function pruneUptimeHistory(history: UptimeSnapshot[]): UptimeSnapshot[] {
  const { maxEntries, retentionSeconds } = config.history;
  let pruned = history;

  if (retentionSeconds > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;
    pruned = pruned.filter((h) => h.timestamp >= cutoff);
  }

  return maxEntries > 0 && pruned.length > maxEntries ? pruned.slice(-maxEntries) : pruned;
}

export function appendUptimeSnapshot(source: string, health: SourceHealthStatus): void {
  ensureDataDir();
  const filePath = UPTIME_FILE(source);
  let history: UptimeSnapshot[] = [];
  try {
    history = readUptimeFile(filePath);
  } catch { /* ignore corrupt data */ }

  const snapshot: UptimeSnapshot = {
    timestamp: Math.floor(Date.now() / 1000),
    healthy: health.healthy,
    uptimePercent: health.uptimePercent,
    totalRequests: health.totalRequests,
    totalFailures: health.totalFailures,
    consecutiveFailures: health.consecutiveFailures,
    lastSuccess: health.lastSuccess,
    lastFailure: health.lastFailure,
  };

  history.push(snapshot);
  writeUptimeFile(filePath, pruneUptimeHistory(history));
}

export function getUptimeHistory(
  source: string,
  from?: number,
  to?: number,
  limit = 720,
): UptimeSnapshot[] {
  const filePath = UPTIME_FILE(source);
  try {
    let history = readUptimeFile(filePath);
    if (from) history = history.filter((h) => h.timestamp >= from);
    if (to) history = history.filter((h) => h.timestamp <= to);
    return history.slice(-limit);
  } catch {
    return [];
  }
}

export function getLatestUptime(source: string): UptimeSnapshot | null {
  const history = getUptimeHistory(source, undefined, undefined, 1);
  return history.length > 0 ? history[0] : null;
}

export function getUptimeForPeriod(
  source: string,
  windowSeconds: number,
): { averageUptimePercent: number; breachCount: number } {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  const history = getUptimeHistory(source, cutoff);
  if (history.length === 0) return { averageUptimePercent: 100, breachCount: 0 };

  const total = history.reduce((sum, h) => sum + h.uptimePercent, 0);
  const averageUptimePercent = Math.round((total / history.length) * 100) / 100;
  const breachCount = history.filter((h) => h.healthy === false).length;

  return { averageUptimePercent, breachCount };
}
