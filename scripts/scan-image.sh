#!/usr/bin/env bash
# scan-image.sh — Local vulnerability scan helper using Trivy
#
# Usage:
#   ./scripts/scan-image.sh [IMAGE_TAG]
#
# If IMAGE_TAG is omitted the script builds the API image from source first.
#
# Environment variables:
#   DOCKERFILE      Path to Dockerfile        (default: ./api/Dockerfile)
#   IMAGE_NAME      Image name                (default: stellar-oracle-api)
#   SEVERITY        Comma-separated levels    (default: CRITICAL,HIGH)
#   IGNORE_UNFIXED  Skip unfixed CVEs (true/false, default: true)
#   OUTPUT_FORMAT   table|json|sarif          (default: table)
#   FAIL_ON_CRITICAL Exit 1 on CRITICAL CVEs  (default: true)
set -euo pipefail

DOCKERFILE="${DOCKERFILE:-./api/Dockerfile}"
IMAGE_NAME="${IMAGE_NAME:-stellar-oracle-api}"
SEVERITY="${SEVERITY:-CRITICAL,HIGH}"
IGNORE_UNFIXED="${IGNORE_UNFIXED:-true}"
OUTPUT_FORMAT="${OUTPUT_FORMAT:-table}"
FAIL_ON_CRITICAL="${FAIL_ON_CRITICAL:-true}"

IMAGE_TAG="${1:-}"
BUILT_LOCALLY=false

log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
info() { log "INFO  $*"; }
err()  { log "ERROR $*" >&2; }

# ── Ensure Trivy is installed ──────────────────────────────────────────────────
if ! command -v trivy &>/dev/null; then
  info "Trivy not found — installing via script..."
  curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
    | sh -s -- -b "$HOME/.local/bin"
  export PATH="$HOME/.local/bin:$PATH"
fi

TRIVY_VERSION=$(trivy --version 2>&1 | head -1)
info "Using: ${TRIVY_VERSION}"

# ── Build image if no tag supplied ─────────────────────────────────────────────
if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG="local-scan-$(date +%Y%m%d%H%M%S)"
  info "No image tag supplied — building from ${DOCKERFILE}..."

  if [[ ! -f "$DOCKERFILE" ]]; then
    err "Dockerfile not found: ${DOCKERFILE}"
    exit 1
  fi

  docker build -f "$DOCKERFILE" -t "${IMAGE_NAME}:${IMAGE_TAG}" .
  BUILT_LOCALLY=true
  info "Built image: ${IMAGE_NAME}:${IMAGE_TAG}"
else
  info "Scanning image: ${IMAGE_TAG}"
fi

# Resolve full image ref
if [[ "$IMAGE_TAG" == *":"* ]]; then
  IMAGE_REF="$IMAGE_TAG"
else
  IMAGE_REF="${IMAGE_NAME}:${IMAGE_TAG}"
fi

# ── Build Trivy flags ──────────────────────────────────────────────────────────
TRIVY_FLAGS=(
  image
  --severity "$SEVERITY"
  --format   "$OUTPUT_FORMAT"
)

if [[ "$IGNORE_UNFIXED" == "true" ]]; then
  TRIVY_FLAGS+=(--ignore-unfixed)
fi

# Write JSON/SARIF to a file; print table to stdout
OUTPUT_FILE=""
if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  OUTPUT_FILE="trivy-report-$(date +%Y%m%d%H%M%S).json"
  TRIVY_FLAGS+=(--output "$OUTPUT_FILE")
elif [[ "$OUTPUT_FORMAT" == "sarif" ]]; then
  OUTPUT_FILE="trivy-report-$(date +%Y%m%d%H%M%S).sarif"
  TRIVY_FLAGS+=(--output "$OUTPUT_FILE")
fi

# ── Run scan ───────────────────────────────────────────────────────────────────
info "Running Trivy scan (severity: ${SEVERITY})..."
SCAN_EXIT=0
trivy "${TRIVY_FLAGS[@]}" "$IMAGE_REF" || SCAN_EXIT=$?

if [[ -n "$OUTPUT_FILE" ]]; then
  info "Report saved to: ${OUTPUT_FILE}"
fi

# ── Clean up locally-built image ───────────────────────────────────────────────
if [[ "$BUILT_LOCALLY" == "true" ]]; then
  docker rmi "${IMAGE_NAME}:${IMAGE_TAG}" 2>/dev/null || true
fi

# ── Gate on CRITICAL ───────────────────────────────────────────────────────────
if [[ "$FAIL_ON_CRITICAL" == "true" && "$SCAN_EXIT" -ne 0 ]]; then
  # Re-run with only CRITICAL to give a targeted exit code
  CRITICAL_EXIT=0
  trivy image --severity CRITICAL --ignore-unfixed --quiet "$IMAGE_REF" || CRITICAL_EXIT=$?
  if [[ "$CRITICAL_EXIT" -ne 0 ]]; then
    err "CRITICAL vulnerabilities detected — failing build."
    exit 1
  fi
fi

info "Scan complete. Exit code: ${SCAN_EXIT}"
exit "$SCAN_EXIT"
