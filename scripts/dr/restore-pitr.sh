#!/usr/bin/env bash
# Tier 1 disaster recovery: point-in-time restore using the continuous WAL archive
# and hourly physical base backups (see k8s/base/timescaledb/statefulset.yaml and
# base-backup-cronjob.yaml).
# See docs/disaster-recovery/recovery-procedures.md#scenario-data-corruption--accidental-delete-tier-1--pitr
#
# Usage: scripts/dr/restore-pitr.sh <env> <target-time|latest>
#   target-time  ISO-8601 timestamp to recover to (e.g. 2026-07-23T14:32:00Z),
#                or "latest" to replay to the newest archived WAL segment.
set -euo pipefail

ENV="${1:?Usage: $0 <env> <target-time|latest>}"
TARGET_TIME="${2:?Usage: $0 <env> <target-time|latest>}"
NAMESPACE="stellar-oracle-${ENV}"
JOB_TIMEOUT_S="${DR_JOB_TIMEOUT_S:-600}"

T0=$(date +%s)
log() { echo "[dr-restore-pitr $(( $(date +%s) - T0 ))s] $*"; }

log "Starting Tier 1 PITR restore for '${ENV}' -> target ${TARGET_TIME}"

log "Step 1/5: freezing writers (aggregator + api scaled to 0)"
kubectl -n "${NAMESPACE}" scale deployment aggregator --replicas=0 || true
kubectl -n "${NAMESPACE}" scale deployment api-stable --replicas=0 || true

log "Step 2/5: stopping timescaledb"
kubectl -n "${NAMESPACE}" scale statefulset timescaledb --replicas=0
kubectl -n "${NAMESPACE}" wait --for=delete pod/timescaledb-0 --timeout=120s || true

RECOVERY_TARGET_CLAUSE="recovery_target_time = '${TARGET_TIME}'"
if [ "${TARGET_TIME}" = "latest" ]; then
  RECOVERY_TARGET_CLAUSE="# no recovery_target_time: replay to end of archived WAL"
fi

log "Step 3/5: running restore job (copy latest base backup, stage WAL replay config)"
kubectl -n "${NAMESPACE}" delete job dr-pitr-restore --ignore-not-found
cat <<EOF | kubectl -n "${NAMESPACE}" apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: dr-pitr-restore
  labels:
    app: timescaledb
    purpose: dr-restore
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: pitr-restore
          image: timescale/timescaledb:latest-pg16
          command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              LATEST_BASE=\$(ls -1dt /base-backups/base_* 2>/dev/null | head -1)
              if [ -z "\${LATEST_BASE}" ]; then
                echo "No base backup found in /base-backups" >&2
                exit 1
              fi
              echo "Restoring from base backup: \${LATEST_BASE}"
              rm -rf /data/*
              cp -a "\${LATEST_BASE}/." /data/
              chown -R 1000:1000 /data
              touch /data/recovery.signal
              cat >> /data/postgresql.auto.conf <<CONF
              restore_command = 'cp /wal-archive/%f %p'
              ${RECOVERY_TARGET_CLAUSE}
              recovery_target_action = 'promote'
              CONF
              echo "Restore staging complete."
          volumeMounts:
            - name: data
              mountPath: /data
            - name: wal-archive
              mountPath: /wal-archive
              readOnly: true
            - name: base-backups
              mountPath: /base-backups
              readOnly: true
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: data-timescaledb-0
        - name: wal-archive
          persistentVolumeClaim:
            claimName: wal-archive-timescaledb-0
        - name: base-backups
          persistentVolumeClaim:
            claimName: timescaledb-base-backups
EOF

kubectl -n "${NAMESPACE}" wait --for=condition=complete job/dr-pitr-restore --timeout="${JOB_TIMEOUT_S}s"
kubectl -n "${NAMESPACE}" delete job dr-pitr-restore

log "Step 4/5: starting timescaledb (will replay WAL to target and auto-promote)"
kubectl -n "${NAMESPACE}" scale statefulset timescaledb --replicas=1
kubectl -n "${NAMESPACE}" rollout status statefulset/timescaledb --timeout="${JOB_TIMEOUT_S}s"

log "Waiting for recovery to complete (recovery.signal cleared on promotion)"
DEADLINE=$(( $(date +%s) + JOB_TIMEOUT_S ))
until kubectl -n "${NAMESPACE}" exec timescaledb-0 -- test ! -f /var/lib/postgresql/data/recovery.signal 2>/dev/null; do
  if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
    log "ERROR: recovery did not complete within ${JOB_TIMEOUT_S}s"
    exit 1
  fi
  sleep 5
done

log "Step 5/5: resuming writers"
kubectl -n "${NAMESPACE}" scale deployment api-stable --replicas=1
kubectl -n "${NAMESPACE}" scale deployment aggregator --replicas=1
kubectl -n "${NAMESPACE}" rollout status deployment/api-stable --timeout=300s
kubectl -n "${NAMESPACE}" rollout status deployment/aggregator --timeout=300s

ELAPSED=$(( $(date +%s) - T0 ))
log "PITR restore complete in ${ELAPSED}s (RTO target: 3600s)"
if [ "${ELAPSED}" -gt 3600 ]; then
  log "WARNING: recovery exceeded the 1-hour RTO target"
fi

echo "${ELAPSED}"
