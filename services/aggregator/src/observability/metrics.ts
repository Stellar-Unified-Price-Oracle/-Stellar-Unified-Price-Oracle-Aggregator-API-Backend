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

export { register };
