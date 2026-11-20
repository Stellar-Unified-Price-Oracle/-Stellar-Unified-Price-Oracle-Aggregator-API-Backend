#!/bin/bash

# fix-history-gaps.sh
# Helper script to detect and backfill price_history gaps
# 
# Usage:
#   ./scripts/fix-history-gaps.sh [--asset BTC] [--since 2024-10-01] [--backfill]
#
# Environment Variables (required):
#   DATABASE_URL - Connection string to the price_history database
#
# Examples:
#   # Detect gaps only (dry-run)
#   ./scripts/fix-history-gaps.sh
#
#   # Detect gaps for last 7 days (default)
#   DATABASE_URL="postgres://..." ./scripts/fix-history-gaps.sh
#
#   # Detect gaps for specific asset
#   ./scripts/fix-history-gaps.sh --asset BTC
#
#   # Auto-backfill detected gaps
#   ./scripts/fix-history-gaps.sh --backfill
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
API_DIR="$REPO_ROOT/api"

# Parse arguments
ASSET=""
SINCE=""
AUTO_BACKFILL=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --asset)
      ASSET="$2"
      shift 2
      ;;
    --since)
      SINCE="$2"
      shift 2
      ;;
    --backfill)
      AUTO_BACKFILL=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate environment
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL environment variable not set"
  echo "Usage: DATABASE_URL='postgres://...' $0 [--asset BTC] [--since 2024-10-01] [--backfill]"
  exit 1
fi

cd "$API_DIR"

# Detect gaps
echo "🔍 Detecting price_history gaps..."
REPORT_FILE="/tmp/gaps-report.json"
DETECT_ARGS=(
  "history:gaps"
  "--"
  "--output" "$REPORT_FILE"
  "--json"
)

if [ -n "$ASSET" ]; then
  DETECT_ARGS+=("--asset" "$ASSET")
fi

if [ -n "$SINCE" ]; then
  DETECT_ARGS+=("--since" "$SINCE")
fi

# Run detector
npm run "${DETECT_ARGS[@]}" || EXIT_CODE=$?

if [ -z "$EXIT_CODE" ]; then
  EXIT_CODE=0
fi

# Parse report
if [ ! -f "$REPORT_FILE" ]; then
  echo "ERROR: Gap detector did not produce a report"
  exit 2
fi

echo ""
echo "📊 Gap Detection Report:"
echo "========================"
cat "$REPORT_FILE" | jq '
  "\(.scannedAssets) assets scanned, \(.scannedRows) rows analyzed"
' -r

ALERTING_GAPS=$(jq '.alertingGaps | length' "$REPORT_FILE")
echo "⚠️  Alerting gaps (> 900s): $ALERTING_GAPS"

if [ "$ALERTING_GAPS" -eq 0 ]; then
  echo ""
  echo "✅ No gaps exceeding threshold. History is clean."
  rm -f "$REPORT_FILE"
  exit 0
fi

echo ""
echo "Gap Details:"
jq '.alertingGaps[] | 
  "\(.asset) | \(.startIso) → \(.endIso) | \(.gapSeconds)s | ~\(.missingSnapshots) missing"' \
  "$REPORT_FILE" -r | while read line; do
  echo "  • $line"
done

if [ "$AUTO_BACKFILL" != true ]; then
  echo ""
  echo "📝 To backfill, run with --backfill flag:"
  echo "   $0 --backfill"
  echo ""
  echo "Or manually backfill individual gaps:"
  jq '.alertingGaps[0]' "$REPORT_FILE" | jq -r '.backfillCommand' | while read cmd; do
    echo "   npm run $cmd"
  done
  rm -f "$REPORT_FILE"
  exit 1
fi

# Auto-backfill mode
echo ""
echo "🔄 Starting auto-backfill..."

BACKFILLED=0
jq '.alertingGaps[]' "$REPORT_FILE" | while read -r gap; do
  ASSET=$(echo "$gap" | jq -r '.asset')
  FROM=$(echo "$gap" | jq -r '.startTs')
  TO=$(echo "$gap" | jq -r '.endTs')
  
  echo ""
  echo "  Backfilling $ASSET from $FROM to $TO..."
  npm run history:backfill -- --asset "$ASSET" --from "$FROM" --to "$TO" || {
    echo "  ❌ Backfill failed for $ASSET"
    exit 2
  }
  BACKFILLED=$((BACKFILLED + 1))
done

echo ""
echo "✨ Backfilled $BACKFILLED gap(s)"
echo ""
echo "🔍 Re-checking gaps..."

# Re-run detector to verify
REPORT_FILE_VERIFY="/tmp/gaps-report-verify.json"
npm run history:gaps -- --output "$REPORT_FILE_VERIFY" --json

REMAINING=$(jq '.alertingGaps | length' "$REPORT_FILE_VERIFY")
if [ "$REMAINING" -eq 0 ]; then
  echo "✅ All gaps closed! Re-run the workflow to confirm."
  rm -f "$REPORT_FILE" "$REPORT_FILE_VERIFY"
  exit 0
else
  echo "⚠️  $REMAINING gap(s) remain. Check the backfill commands and retry."
  rm -f "$REPORT_FILE" "$REPORT_FILE_VERIFY"
  exit 1
fi

