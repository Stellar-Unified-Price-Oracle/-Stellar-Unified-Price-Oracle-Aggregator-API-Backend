/**
 * #117 — Distributed Feature Flag System with basic A/B testing
 *
 * Flags are defined here in code. In production they can be overridden by
 * environment variables (FEATURE_FLAGS_JSON) or a remote config store — the
 * evaluator checks the override map before falling back to the compiled
 * defaults, so no code change is needed for runtime flag changes.
 *
 * A/B Rollout:
 *   Each flag may specify a `rolloutPct` (0–100). The evaluator hashes the
 *   caller's `entityId` (e.g. API key, user id, or IP) against the flag name
 *   to deterministically assign the entity to a bucket, enabling stable
 *   percentage-based rollouts without a database.
 *
 * Automated rollback:
 *   If a flag's error rate (tracked via `recordFlagError`) exceeds
 *   `autoDisableErrorRate` within the observation window, the flag is
 *   automatically disabled in-process and an alert is logged.
 */

import { createHash } from 'crypto';
import { logger as defaultLogger } from '../observability/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlagVariant = 'control' | 'treatment' | string;

export interface FlagDefinition {
  /** Human-readable description. */
  description: string;
  /** Whether the flag is globally enabled. */
  enabled: boolean;
  /**
   * Percentage of entities that receive the "treatment" variant (0–100).
   * 100 means all entities; 0 means none (same as enabled: false).
   */
  rolloutPct: number;
  /**
   * If the flag's error rate exceeds this threshold (0–1), it is auto-disabled.
   * Set to 1 to disable auto-rollback.
   */
  autoDisableErrorRate: number;
  /** Optional metadata for dashboards / audit logs. */
  metadata?: Record<string, unknown>;
}

export interface EvaluationResult {
  flagKey: string;
  enabled: boolean;
  variant: FlagVariant;
  reason: 'disabled' | 'rollout' | 'forced' | 'auto-disabled';
}

// ---------------------------------------------------------------------------
// Flag registry — compiled defaults
// ---------------------------------------------------------------------------

const FLAG_REGISTRY: Record<string, FlagDefinition> = {
  'v2-price-endpoint': {
    description: 'Serve price data from the v2 aggregation pipeline',
    enabled: true,
    rolloutPct: 100,
    autoDisableErrorRate: 0.05,
  },
  'batch-price-queries': {
    description: 'Enable the POST /api/v2/prices/batch endpoint',
    enabled: true,
    rolloutPct: 100,
    autoDisableErrorRate: 0.1,
  },
  'experimental-caching': {
    description: 'Use the new HybridCache for v2 responses (A/B: 50% of traffic)',
    enabled: true,
    rolloutPct: 50,
    autoDisableErrorRate: 0.02,
  },
  'websocket-price-feed': {
    description: 'Expose live price updates over WebSocket',
    enabled: true,
    rolloutPct: 100,
    autoDisableErrorRate: 0.05,
  },
  'rate-limit-v2-relaxed': {
    description: 'Apply a relaxed rate limit to authenticated v2 users',
    enabled: false,
    rolloutPct: 0,
    autoDisableErrorRate: 1,
  },
  'post-quantum-crypto': {
    description: 'Enable hybrid Ed25519 and post-quantum signature verification',
    enabled: false,
    rolloutPct: 0,
    autoDisableErrorRate: 0.01,
  },
  'programmable-feeds': {
    description: 'Enable user-defined programmable feed deployment and marketplace APIs',
    enabled: false,
    rolloutPct: 0,
    autoDisableErrorRate: 0.02,
  },
  'schema-migrations-v2': {
    description: 'Enable dark-read zero-downtime schema migration framework',
    enabled: false,
    rolloutPct: 0,
    autoDisableErrorRate: 0.01,
  },
  'high-throughput-pipeline': {
    description: 'Enable the bounded fan-out and batch-processing price pipeline',
    enabled: false,
    rolloutPct: 0,
    autoDisableErrorRate: 0.05,
  },
};

// ---------------------------------------------------------------------------
// Runtime state (in-process; survives for the lifetime of the process)
// ---------------------------------------------------------------------------

interface FlagMetrics {
  calls: number;
  errors: number;
  autoDisabled: boolean;
  disabledAt?: Date;
}

const runtimeState: Record<string, FlagMetrics> = {};

function getState(key: string): FlagMetrics {
  if (!runtimeState[key]) {
    runtimeState[key] = { calls: 0, errors: 0, autoDisabled: false };
  }
  return runtimeState[key];
}

// ---------------------------------------------------------------------------
// Env overrides  (FEATURE_FLAGS_JSON='{"experimental-caching":{"enabled":false}}')
// ---------------------------------------------------------------------------

function loadEnvOverrides(): Record<string, Partial<FlagDefinition>> {
  const raw = process.env.FEATURE_FLAGS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    defaultLogger.warn('FEATURE_FLAGS_JSON is set but is not valid JSON — overrides ignored');
    return {};
  }
}

let _envOverrides: Record<string, Partial<FlagDefinition>> | null = null;
function envOverrides(): Record<string, Partial<FlagDefinition>> {
  if (!_envOverrides) _envOverrides = loadEnvOverrides();
  return _envOverrides;
}

// ---------------------------------------------------------------------------
// Deterministic bucket assignment (stable hash)
// ---------------------------------------------------------------------------

function bucketPct(flagKey: string, entityId: string): number {
  const digest = createHash('sha256')
    .update(`${flagKey}:${entityId}`)
    .digest('hex')
    .slice(0, 8);
  return (parseInt(digest, 16) % 100) + 1; // 1–100
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a feature flag for an entity.
 *
 * @param flagKey   - Flag identifier (must match FLAG_REGISTRY key).
 * @param entityId  - Stable identifier for the caller (API key, user id, IP).
 *                    Pass '' or omit to use pure rollout percentage.
 */
export function evaluateFlag(flagKey: string, entityId = ''): EvaluationResult {
  const base: FlagDefinition = FLAG_REGISTRY[flagKey] ?? {
    description: 'Unknown flag',
    enabled: false,
    rolloutPct: 0,
    autoDisableErrorRate: 1,
  };
  const override = envOverrides()[flagKey] ?? {};
  const def: FlagDefinition = { ...base, ...override };
  const state = getState(flagKey);

  if (state.autoDisabled) {
    return { flagKey, enabled: false, variant: 'control', reason: 'auto-disabled' };
  }

  if (!def.enabled || def.rolloutPct === 0) {
    return { flagKey, enabled: false, variant: 'control', reason: 'disabled' };
  }

  // Forced full rollout
  if (def.rolloutPct >= 100 || entityId === '') {
    state.calls++;
    return { flagKey, enabled: true, variant: 'treatment', reason: 'rollout' };
  }

  const bucket = bucketPct(flagKey, entityId);
  if (bucket <= def.rolloutPct) {
    state.calls++;
    return { flagKey, enabled: true, variant: 'treatment', reason: 'rollout' };
  }

  return { flagKey, enabled: false, variant: 'control', reason: 'rollout' };
}

/**
 * Record an error attributed to a flag's treatment path.
 * If the error rate exceeds `autoDisableErrorRate`, the flag is auto-disabled.
 */
export function recordFlagError(flagKey: string): void {
  const state = getState(flagKey);
  state.errors++;
  const base = FLAG_REGISTRY[flagKey];
  if (!base) return;
  const threshold = (envOverrides()[flagKey]?.autoDisableErrorRate ?? base.autoDisableErrorRate);
  const errorRate = state.calls > 0 ? state.errors / state.calls : 0;
  if (errorRate >= threshold && !state.autoDisabled) {
    state.autoDisabled = true;
    state.disabledAt = new Date();
    defaultLogger.error(
      `Feature flag "${flagKey}" auto-disabled due to high error rate`,
      { flagKey, errorRate: errorRate.toFixed(3), threshold }
    );
  }
}

/**
 * Return a snapshot of all flags and their current status.
 * Used by the GET /api/feature-flags endpoint.
 */
export function getAllFlagStatuses(): Record<string, object> {
  const overrides = envOverrides();
  const out: Record<string, object> = {};

  for (const [key, base] of Object.entries(FLAG_REGISTRY)) {
    const override = overrides[key] ?? {};
    const def = { ...base, ...override };
    const state = getState(key);
    out[key] = {
      description: def.description,
      enabled: def.enabled && !state.autoDisabled,
      rolloutPct: def.rolloutPct,
      autoDisabled: state.autoDisabled,
      disabledAt: state.disabledAt ?? null,
      calls: state.calls,
      errors: state.errors,
      errorRate: state.calls > 0 ? +(state.errors / state.calls).toFixed(4) : 0,
    };
  }
  return out;
}

/**
 * Re-enable a flag that was auto-disabled (admin action).
 * Also resets error counters.
 */
export function resetFlag(flagKey: string): boolean {
  if (!FLAG_REGISTRY[flagKey]) return false;
  const state = getState(flagKey);
  state.autoDisabled = false;
  state.disabledAt = undefined;
  state.calls = 0;
  state.errors = 0;
  defaultLogger.info(`Feature flag "${flagKey}" manually reset`, { flagKey });
  return true;
}
