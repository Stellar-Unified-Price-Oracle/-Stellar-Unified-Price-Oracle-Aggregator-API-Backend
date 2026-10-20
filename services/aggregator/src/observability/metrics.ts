import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const serviceStartupDurationMs = new client.Gauge({
  name: 'service_startup_duration_ms',
  help: 'Time from process start until service warm-up finishes and the ready endpoint can pass',
  labelNames: ['service'],
  registers: [register],
});

// #63 — WebSocket connection monitoring
export const wsConnectionsActive = new client.Gauge({
  name: 'ws_connections_active',
  help: 'Current number of active WebSocket connections',
  labelNames: ['service'],
  registers: [register],
});

export const wsConnectionsTotal = new client.Counter({
  name: 'ws_connections_total',
  help: 'Total WebSocket connections ever established',
  labelNames: ['service'],
  registers: [register],
});

export const wsMessagesTotal = new client.Counter({
  name: 'ws_messages_total',
  help: 'Total WebSocket messages',
  labelNames: ['service', 'direction'],
  registers: [register],
});

export const wsConnectionDuration = new client.Histogram({
  name: 'ws_connection_duration_seconds',
  help: 'WebSocket connection duration in seconds',
  labelNames: ['service'],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
});

export const wsErrorsTotal = new client.Counter({
  name: 'ws_errors_total',
  help: 'Total WebSocket errors',
  labelNames: ['service'],
  registers: [register],
});

// Issue #586 — upgrade rejections counted by reason so rate-limit bypass
// attempts, origin failures and auth failures are individually observable.
export const wsUpgradeRejectionsTotal = new client.Counter({
  name: 'ws_upgrade_rejections_total',
  help: 'WebSocket upgrade rejections by reason (rate-limit, origin, csrf, hmac, ...)',
  labelNames: ['service', 'reason'],
  registers: [register],
});

// #64 — Oracle source latency tracking
export const oracleSourceLatency = new client.Histogram({
  name: 'oracle_source_request_duration_seconds',
  help: 'Oracle source API request latency in seconds',
  labelNames: ['source', 'asset', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const oracleSourceRequestsTotal = new client.Counter({
  name: 'oracle_source_requests_total',
  help: 'Total requests to external oracle sources',
  labelNames: ['source', 'status'],
  registers: [register],
});

export const oracleSourceSlaBreaches = new client.Counter({
  name: 'oracle_source_sla_breaches_total',
  help: 'Number of oracle source requests exceeding SLA threshold',
  labelNames: ['source'],
  registers: [register],
});

// #583 — budget-blocked fetches: a source whose daily budget is exhausted
// stops being polled, which degrades aggregation quality and must stay visible.
export const oracleSourceBudgetBlockedTotal = new client.Counter({
  name: 'oracle_source_budget_blocked_total',
  help: 'Fetches skipped because the source daily API budget was exhausted, by source',
  labelNames: ['source'],
  registers: [register],
});

// Issue #584 — schema violations are a provider contract change, not an
// ordinary fetch failure. Sustained rates must page, not degrade quietly.
export const oracleSourceInvalidPayloadsTotal = new client.Counter({
  name: 'oracle_source_invalid_payloads_total',
  help: 'Provider responses that failed schema validation, by source',
  labelNames: ['source'],
  registers: [register],
});

// #65 — Cost tracking per oracle API call
export const oracleApiCallsTotal = new client.Counter({
  name: 'oracle_api_calls_total',
  help: 'Total API calls to external oracle sources',
  labelNames: ['source'],
  registers: [register],
});

export const oracleApiCostTotal = new client.Counter({
  name: 'oracle_api_cost_estimated_usd_total',
  help: 'Estimated cumulative cost in USD micro-cents for oracle API calls',
  labelNames: ['source'],
  registers: [register],
});

export const oracleApiBudgetUtilization = new client.Gauge({
  name: 'oracle_api_budget_utilization_ratio',
  help: 'Ratio of estimated daily spend vs configured daily budget (0–1+)',
  labelNames: ['source'],
  registers: [register],
});

export const oracleSourceUptimePercent = new client.Gauge({
  name: 'oracle_source_uptime_percent',
  help: 'Current uptime percentage per oracle source (0–100)',
  labelNames: ['source'],
  registers: [register],
});

// Issue #382 — on-chain price staleness heartbeat.
export const onChainPriceStalenessSeconds = new client.Gauge({
  name: 'onchain_price_staleness_seconds',
  help: 'Seconds since the last on-chain price update per asset, as read directly from the oracle contract',
  labelNames: ['asset'],
  registers: [register],
});

export const onChainHeartbeatAlertsTotal = new client.Counter({
  name: 'onchain_heartbeat_alerts_total',
  help: 'Number of times the on-chain staleness heartbeat exceeded STALENESS_THRESHOLD_MS',
  labelNames: ['asset'],
  registers: [register],
});

export const contractSubmissionGas = new client.Histogram({
  name: 'contract_submission_gas',
  help: 'Gas used by Soroban contract submissions in stroops',
  labelNames: ['function', 'asset', 'status'],
  buckets: [1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000, 10000000],
  registers: [register],
});

export const contractSubmissionGasTotal = new client.Counter({
  name: 'contract_submission_gas_total',
  help: 'Total gas used by Soroban contract submissions',
  labelNames: ['function', 'asset', 'status'],
  registers: [register],
});

// Issue #105 — canary deployments for contract upgrades.
export const canaryActive = new client.Gauge({
  name: 'canary_active',
  help: 'Whether a canary implementation is currently receiving traffic (1) or not (0)',
  registers: [register],
});

export const canaryTrafficShareBps = new client.Gauge({
  name: 'canary_traffic_share_bps',
  help: 'On-chain canary traffic share in basis points (0–10000)',
  registers: [register],
});

export const canaryConsecutiveFailures = new client.Gauge({
  name: 'canary_consecutive_failures',
  help: 'Current streak of consecutive canary submission failures',
  registers: [register],
});

export const canarySubmissionsTotal = new client.Counter({
  name: 'canary_submissions_total',
  help: 'Total submissions routed to the canary implementation',
  labelNames: ['status'],
  registers: [register],
});

export const canaryRollbacksTotal = new client.Counter({
  name: 'canary_rollbacks_total',
  help: 'Number of times the canary was rolled back after crossing the failure threshold',
  registers: [register],
});

export const pipelineStageLatencyMs = new client.Histogram({
  name: 'pipeline_stage_latency_ms',
  help: 'Latency budget for each stage of the price pipeline in milliseconds',
  labelNames: ['stage', 'status'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

// Issue #577 — Merkle batch path vs per-asset submission metrics.
// Distinguishes the batch (submit_batch + N apply_batch_entry) path from the
// per-asset (N x submit_price) path so operators can compare round cost.
export const contractSubmissionsTotal = new client.Counter({
  name: 'contract_submissions_total',
  help: 'Total contract submissions grouped by path (batch|per_asset) and status',
  labelNames: ['path', 'status'],
  registers: [register],
});

export const contractBatchRoundFeesTotal = new client.Counter({
  name: 'contract_batch_round_fees_total',
  help: 'Total fees (stroops) charged across all transactions in a batch round',
  labelNames: ['path'],
  registers: [register],
});

export const contractBatchRoundTransactions = new client.Histogram({
  name: 'contract_batch_round_transactions',
  help: 'Number of transactions used per publish round (1 for batch commit + N applies vs N for per-asset)',
  labelNames: ['path'],
  buckets: [1, 2, 4, 8, 16, 32, 64],
  registers: [register],
});

// Issue #576 — submission outcome metrics (distinct from send latency).
// contractSubmissionOutcome.inc() is called only once getTransaction resolves
// with a terminal status so the counter reflects real on-chain outcomes, not
// just network acceptance.
export const contractSubmissionOutcome = new client.Counter({
  name: 'contract_submission_outcome_total',
  help: 'Terminal outcome of a Soroban transaction: success, failed, timeout, or not_found',
  labelNames: ['function', 'asset', 'outcome'],
  registers: [register],
});

// Ratio of failed outcomes to total outcomes in the last measurement window.
// Alert when this ratio exceeds an operator-defined threshold (not just on
// exceptions, which the send error path already covers).
export const contractOutcomeFailureRatio = new client.Gauge({
  name: 'contract_outcome_failure_ratio',
  help: 'Rolling ratio of failed on-chain submission outcomes (failed+timeout+not_found) to total outcomes',
  labelNames: ['function'],
  registers: [register],
});

// Sliding window counters for failure-ratio calculation.
export const contractOutcomeTotalWindow = new client.Gauge({
  name: 'contract_outcome_total_window',
  help: 'Total submission outcomes tracked in the current failure-ratio window',
  labelNames: ['function'],
  registers: [register],
});

export const contractOutcomeFailedWindow = new client.Gauge({
  name: 'contract_outcome_failed_window',
  help: 'Failed submission outcomes (failed+timeout+not_found) in the current failure-ratio window',
  labelNames: ['function'],
  registers: [register],
});

// Issue #578 — RPC call tracking per round and total
export const contractRpcCallsTotal = new client.Counter({
  name: 'contract_rpc_calls_total',
  help: 'Total RPC calls made to Soroban RPC by type',
  labelNames: ['call_type'],
  registers: [register],
});

export const contractRpcCallsPerRound = new client.Gauge({
  name: 'contract_rpc_calls_per_round',
  help: 'Number of RPC calls made in the most recent publish and heartbeat round',
  labelNames: ['call_type'],
  registers: [register],
});

// Issue #575 — Poll loop duration and overruns
export const pollCycleDurationMs = new client.Histogram({
  name: 'poll_cycle_duration_ms',
  help: 'Duration of aggregator poll cycles in milliseconds',
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000, 60000],
  registers: [register],
});

export const pollCycleOverrunsTotal = new client.Counter({
  name: 'poll_cycle_overruns_total',
  help: 'Total number of poll cycles that overran their configured interval or were skipped',
  registers: [register],
});

// Issue #574 — Retry queue depth and orphaned retry tracking
export const retryQueueDepth = new client.Gauge({
  name: 'retry_queue_depth',
  help: 'Current number of submissions waiting in the publisher retry queue',
  registers: [register],
});

export const retryQueueOrphanedRetriesTotal = new client.Counter({
  name: 'retry_queue_orphaned_retries_total',
  help: 'Total number of retries that were orphaned or dropped on shutdown',
  registers: [register],
});

// Issue #589 — History file integrity
export const historyFileReadFailuresTotal = new client.Counter({
  name: 'history_file_read_failures_total',
  help: 'Total history file read failures by asset and reason (unreadable, undecryptable, malformed)',
  labelNames: ['asset', 'reason'],
  registers: [register],
});

export const historyFileQuarantinesTotal = new client.Counter({
  name: 'history_file_quarantines_total',
  help: 'Total history files moved to data/quarantine after a parse or decrypt failure',
  labelNames: ['asset', 'reason'],
  registers: [register],
});

export const historyFileWriteFailuresTotal = new client.Counter({
  name: 'history_file_write_failures_total',
  help: 'Total history file append failures by asset and reason',
  labelNames: ['asset', 'reason'],
  registers: [register],
});

// Issue #741 — controlled brownout mode.
// The current brownout tier (0 = full service, higher = more shedding) so
// operators can see at a glance which partial-service mode is active.
export const brownoutTier = new client.Gauge({
  name: 'brownout_tier',
  help: 'Current brownout tier (0 = full service, 1 = light, 2 = heavy shedding)',
  registers: [register],
});

export const brownoutTierTransitionsTotal = new client.Counter({
  name: 'brownout_tier_transitions_total',
  help: 'Number of brownout tier transitions by from/to tier and trigger',
  labelNames: ['from_tier', 'to_tier', 'trigger'],
  registers: [register],
});

// Non-critical work skipped while a brownout tier is active. Price freshness
// and publication are never shed, so these counters must be the only work
// dropped during a brownout.
export const brownoutShedOperationsTotal = new client.Counter({
  name: 'brownout_shed_operations_total',
  help: 'Non-critical operations skipped because of brownout shedding, by feature and tier',
  labelNames: ['feature', 'tier'],
  registers: [register],
});

export const brownoutActiveDurationSeconds = new client.Gauge({
  name: 'brownout_active_duration_seconds',
  help: 'Seconds the current brownout tier has been continuously active (0 when full service)',
  registers: [register],
});

// Issue #742 — regional maintenance windows.
// Phase durations let operators verify prechecks, drain, fencing and
// validation each complete within their budget.
export const maintenanceWindowPhaseDurationMs = new client.Histogram({
  name: 'maintenance_window_phase_duration_ms',
  help: 'Duration of each maintenance window phase in milliseconds',
  labelNames: ['region', 'phase', 'status'],
  buckets: [100, 500, 1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000],
  registers: [register],
});

export const maintenanceWindowPrechecksTotal = new client.Counter({
  name: 'maintenance_window_prechecks_total',
  help: 'Maintenance window precheck results by region, check name and outcome (pass|fail)',
  labelNames: ['region', 'check', 'outcome'],
  registers: [register],
});

export const maintenanceWindowPostchecksTotal = new client.Counter({
  name: 'maintenance_window_postchecks_total',
  help: 'Maintenance window post-maintenance validation results by region, check name and outcome (pass|fail)',
  labelNames: ['region', 'check', 'outcome'],
  registers: [register],
});

export const maintenanceWindowAbortsTotal = new client.Counter({
  name: 'maintenance_window_aborts_total',
  help: 'Maintenance windows aborted before completion, by region and reason',
  labelNames: ['region', 'reason'],
  registers: [register],
});

export const maintenanceWindowActive = new client.Gauge({
  name: 'maintenance_window_active',
  help: 'Whether a maintenance window is currently active for a region (1) or not (0)',
  labelNames: ['region'],
  registers: [register],
});

export { register };

