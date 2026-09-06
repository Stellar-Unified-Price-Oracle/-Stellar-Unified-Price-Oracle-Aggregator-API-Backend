#!/usr/bin/env bash
# Quarterly DR drill runner. See docs/disaster-recovery/drills.md.
#
# Simulates a disaster against the target environment (staging only — this script
# refuses to run against production), invokes the matching recovery script, measures
# RTO/RPO against the configured targets, and writes a report.
#
# Usage: scripts/dr/run-drill.sh <env> [tier1|tier2]
set -euo pipefail

ENV="${1:?Usage: $0 <env> [tier1|tier2]}"
TIER="${2:-tier2}"
NAMESPACE="stellar-oracle-${ENV}"
RTO_TARGET_S="${DR_RTO_TARGET_SECONDS:-3600}"
RPO_TARGET_S="${DR_RPO_TARGET_SECONDS:-300}"
API_BASE_URL="${API_BASE_URL:?Set API_BASE_URL}"
ADMIN_API_KEY="${ADMIN_API_KEY:?Set ADMIN_API_KEY}"

if [ "${ENV}" = "production" ] || [ "${ENV}" = "prod" ]; then
  echo "Refusing to run a DR drill against production. Use staging." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORT_DIR="${ROOT}/docs/disaster-recovery/reports"
mkdir -p "${REPORT_DIR}"

DATE_TAG=$(date -u +%Y%m%d-%H%M%S)
DISASTER_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "=== DR Drill: env=${ENV} tier=${TIER} started at ${DISASTER_TIME} ==="

echo "--- Pre-drill fingerprint ---"
PRE_MAX_TS=$(kubectl -n "${NAMESPACE}" exec timescaledb-0 -- \
  psql -U oracle -d stellar_oracle -tAc "SELECT max(observed_at) FROM price_history;" 2>/dev/null || echo "")
echo "Latest observed_at before drill: ${PRE_MAX_TS:-unknown}"

RTO_SECONDS=""
PASSED=true

if [ "${TIER}" = "tier1" ]; then
  echo "--- Simulating corruption (tier1) ---"
  MARKER_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  kubectl -n "${NAMESPACE}" exec timescaledb-0 -- \
    psql -U oracle -d stellar_oracle -c \
    "CREATE TABLE IF NOT EXISTS dr_drill_scratch (marker text, created_at timestamptz default now()); INSERT INTO dr_drill_scratch (marker) VALUES ('drill-${DATE_TAG}');" \
    >/dev/null
  sleep 65 # ensure the marker insert is past a WAL archive_timeout boundary

  echo "--- Running Tier 1 restore to just before the marker ---"
  RTO_SECONDS=$(bash "${ROOT}/scripts/dr/restore-pitr.sh" "${ENV}" "${MARKER_TIME}" | tail -1)

  MARKER_STILL_PRESENT=$(kubectl -n "${NAMESPACE}" exec timescaledb-0 -- \
    psql -U oracle -d stellar_oracle -tAc \
    "SELECT count(*) FROM dr_drill_scratch WHERE marker = 'drill-${DATE_TAG}';" 2>/dev/null || echo "1")
  if [ "${MARKER_STILL_PRESENT}" -ne 0 ]; then
    echo "FAIL: marker row survived the point-in-time restore — recovery did not roll back to target time"
    PASSED=false
  fi
else
  echo "--- Simulating full volume loss (tier2) ---"
  kubectl -n "${NAMESPACE}" scale statefulset timescaledb --replicas=0
  kubectl -n "${NAMESPACE}" wait --for=delete pod/timescaledb-0 --timeout=120s || true
  kubectl -n "${NAMESPACE}" delete pvc data-timescaledb-0 wal-archive-timescaledb-0 --ignore-not-found

  echo "--- Running Tier 2 full recovery ---"
  RTO_SECONDS=$(bash "${ROOT}/scripts/dr/recover.sh" "${ENV}" | tail -1)
fi

echo "--- Post-drill verification ---"
POST_MAX_TS=$(kubectl -n "${NAMESPACE}" exec timescaledb-0 -- \
  psql -U oracle -d stellar_oracle -tAc "SELECT max(observed_at) FROM price_history;" 2>/dev/null || echo "")
echo "Latest observed_at after recovery: ${POST_MAX_TS:-unknown}"

HEALTH_OK=false
if curl -sf "${API_BASE_URL}/api/v1/health" >/dev/null; then HEALTH_OK=true; fi

RPO_SECONDS=0
if [ -n "${POST_MAX_TS}" ] && [ -n "${DISASTER_TIME}" ]; then
  DISASTER_EPOCH=$(date -u -d "${DISASTER_TIME}" +%s 2>/dev/null || date -u -jf "%Y-%m-%dT%H:%M:%SZ" "${DISASTER_TIME}" +%s)
  POST_EPOCH=$(date -u -d "${POST_MAX_TS}" +%s 2>/dev/null || echo "${DISASTER_EPOCH}")
  RPO_SECONDS=$(( DISASTER_EPOCH - POST_EPOCH ))
  [ "${RPO_SECONDS}" -lt 0 ] && RPO_SECONDS=0
fi

[ "${RTO_SECONDS:-99999}" -le "${RTO_TARGET_S}" ] || PASSED=false
[ "${RPO_SECONDS}" -le "${RPO_TARGET_S}" ] || PASSED=false
[ "${HEALTH_OK}" = true ] || PASSED=false

REPORT_MD="${REPORT_DIR}/drill-${DATE_TAG}.md"
cat > "${REPORT_MD}" <<REPORT
# DR Drill Report — ${DATE_TAG}

- **Environment**: ${ENV}
- **Tier**: ${TIER}
- **Disaster simulated at**: ${DISASTER_TIME}
- **RTO measured**: ${RTO_SECONDS}s (target: ${RTO_TARGET_S}s)
- **RPO measured**: ${RPO_SECONDS}s (target: ${RPO_TARGET_S}s)
- **Health check**: ${HEALTH_OK}
- **Result**: $([ "${PASSED}" = true ] && echo "PASS" || echo "FAIL")
REPORT

REPORT_JSON="${REPORT_DIR}/latest.json"
TIER_LABEL="tier2-full"
[ "${TIER}" = "tier1" ] && TIER_LABEL="tier1-pitr"
cat > "${REPORT_JSON}" <<JSON
{
  "date": "${DISASTER_TIME}",
  "environment": "${ENV}",
  "tier": "${TIER_LABEL}",
  "rtoSeconds": ${RTO_SECONDS:-0},
  "rpoSeconds": ${RPO_SECONDS},
  "rtoTargetSeconds": ${RTO_TARGET_S},
  "rpoTargetSeconds": ${RPO_TARGET_S},
  "passed": $([ "${PASSED}" = true ] && echo "true" || echo "false"),
  "report": "drill-${DATE_TAG}.md"
}
JSON

echo "=== Drill result: $([ "${PASSED}" = true ] && echo PASS || echo FAIL) ==="
echo "Report: ${REPORT_MD}"

if [ "${PASSED}" != true ]; then
  exit 1
fi
