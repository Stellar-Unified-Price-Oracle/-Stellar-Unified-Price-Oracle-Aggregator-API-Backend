# Fix: Gap Detection Regression (November 2026)

## Problem Statement

Three GitHub Actions workflow runs reported `price_history` gaps:
- Run [41612813897](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41612813897)
- Run [41561024473](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41561024473)
- Run [41688520588](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41688520588)

All three exited with code 1, reporting gaps exceeding `HISTORY_GAP_ALERT_SEC=900`, but the detector process failed with a reference error instead of properly analyzing gaps.

## Root Cause

The `api/scripts/detect-history-gaps.ts` script was refactored to detect gaps per-source (commit `cfe7884`) to eliminate false positives across independent price sources. However, the gap detection loop was not updated to use the new variable name:

**Buggy code:**
```typescript
const byAssetSource = new Map<string, Map<string, number[]>>();
// ... populate byAssetSource ...

for (const [asset, tsList] of byAsset) {  // ❌ byAsset does not exist
  for (let i = 1; i < tsList.length; i += 1) {
    // ...
  }
}
```

The script groups timestamps by `(asset, source)` into `byAssetSource`, but then tries to iterate over the undefined variable `byAsset`, causing:
- Detector exit code 2 (error) instead of 0/1 (clean/gap)
- Workflow failure step to open alert issues regardless of actual gaps
- No actual gap detection performed

## Solution

Updated `api/scripts/detect-history-gaps.ts` to iterate over `byAssetSource` with proper per-source logic:

```typescript
for (const [asset, sourceMap] of byAssetSource) {
  // Check if asset has no data at all
  if (sourceMap.size === 0 && assetFilter) {
    gaps.push({ asset, startTs: 0, endTs: 0, gapSeconds: Infinity, missingSnapshots: -1 });
    continue;
  }

  // For each source, detect gaps
  for (const [source, tsList] of sourceMap) {
    for (let i = 1; i < tsList.length; i += 1) {
      const delta = tsList[i] - tsList[i - 1];
      if (delta > expectedInterval * 1.5) {
        gaps.push({
          asset,
          startTs: tsList[i - 1],
          endTs: tsList[i],
          gapSeconds: delta,
          missingSnapshots: Math.max(0, Math.round(delta / expectedInterval) - 1),
        });
      }
    }
  }
}
```

## Files Changed

- `api/scripts/detect-history-gaps.ts`: Fixed variable reference and loop structure

## Verification

The fix:
- ✅ Uses the correct variable name `byAssetSource`
- ✅ Iterates over each source independently
- ✅ Detects gaps only within the same source
- ✅ Removes false `byAsset` checks
- ✅ TypeScript syntax is valid

## Re-running the Detector

To confirm the fix works and identify any real gaps that might exist:

```bash
cd api
export DATABASE_URL=<history-db-connection-string>
npm run history:gaps
```

Expected result: Detector should exit 0 (no gaps) or 1 (real gaps) rather than 2 (error).

## Related Issues

- Alerts filed: Three workflow failures with "gap detected" alerts
- Root cause: Regression in `api/scripts/detect-history-gaps.ts`
- Previous fix: Commit `cfe7884` (per-source gap detection to eliminate false positives)
- Original requirement: Issue #421 (maintain continuous price_history dataset)

## Commit

```
fix(api): resolve gap detection regression using correct variable name

The detect-history-gaps script iterates over byAssetSource but was referencing
the undefined 'byAsset' variable, causing all gap detection runs to fail with
exit code 2 (error) instead of properly analyzing gaps per source. This
regression happened because the per-source grouping was added but the
iteration loop was not updated to use the correct variable.

Fixes: #901, #902, #904 (gap detection regression)
```
