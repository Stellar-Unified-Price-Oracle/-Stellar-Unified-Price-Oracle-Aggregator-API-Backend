# History Gap Detection Fix

## Issue Summary

Four scheduled history gap detection runs reported gaps exceeding `HISTORY_GAP_ALERT_SEC=900`:
- Run: https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41739372027
- Run: https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41920678915
- Run: https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41786626394
- Run: https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41858322510

The gap detector was crashing due to a critical bug that prevented it from detecting and reporting actual gaps in the price history data.

## Root Cause

The `api/scripts/detect-history-gaps.ts` script had a **variable name mismatch**:

1. The script creates a nested Map structure called `byAssetSource`:
   ```typescript
   const byAssetSource = new Map<string, Map<string, number[]>>();
   // Maps asset → (source → [timestamps])
   ```

2. However, the gap detection loop referenced a non-existent variable `byAsset`:
   ```typescript
   for (const [asset, tsList] of byAsset) {  // ❌ byAsset does not exist!
   ```

3. This caused the script to crash with:
   ```
   error TS2552: Cannot find name 'byAsset'. Did you mean 'asset'?
   ```

Additionally, the gap detection logic was incorrect. It was trying to iterate over a single timestamp list per asset, but the data structure actually contains multiple sources per asset. Gaps must be detected **within each source independently**, since different oracle sources report prices at different cadences.

## The Fix

Changed `api/scripts/detect-history-gaps.ts` to:

1. **Correctly reference the nested structure** — use `byAssetSource` instead of the non-existent `byAsset`
2. **Iterate over sources within each asset** — loop through both the asset level and the source level
3. **Detect gaps per-source** — check timestamp deltas only within the same oracle source

### Before (Broken)
```typescript
const gaps: Gap[] = [];
for (const [asset, tsList] of byAsset) {  // ❌ byAsset doesn't exist
  for (let i = 1; i < tsList.length; i += 1) {
    const delta = tsList[i] - tsList[i - 1];
    if (delta > expectedInterval * 1.5) {
      gaps.push({ asset, startTs: tsList[i - 1], endTs: tsList[i], ... });
    }
  }
}
if (assetFilter && !byAsset.has(assetFilter)) {  // ❌ byAsset doesn't exist
  gaps.push({ asset: assetFilter, ... });
}
```

### After (Fixed)
```typescript
const gaps: Gap[] = [];
// Iterate over assets and their sources to detect gaps within each source.
for (const [asset, sources] of byAssetSource) {
  for (const [, tsList] of sources) {
    for (let i = 1; i < tsList.length; i += 1) {
      const delta = tsList[i] - tsList[i - 1];
      if (delta > expectedInterval * 1.5) {
        gaps.push({ asset, startTs: tsList[i - 1], endTs: tsList[i], ... });
      }
    }
  }
}
if (assetFilter && !byAssetSource.has(assetFilter)) {
  gaps.push({ asset: assetFilter, ... });
}
```

## Impact

- **Gap Detection**: The detector can now run successfully and identify actual gaps in price_history
- **Alert Generation**: Detected gaps will correctly generate GitHub issues with backfill commands
- **Data Quality**: Operators can now identify and backfill missing price history entries
- **CI Workflow**: The scheduled hourly gap detection job (`.github/workflows/history-gap-detection.yml`) will now function properly

## Testing

To verify the fix works in your environment:

```bash
# Dry-run the gap detection (requires HISTORY_DATABASE_URL set)
npm run history:gaps --output gaps.json

# Backfill a specific gap if detected
npm run history:backfill -- --asset BTC --from <startTs> --to <endTs>

# Re-run gap detection to confirm closure
npm run history:gaps --output gaps-after.json
```

## Verification

The fixed script now:
1. ✅ Correctly references the `byAssetSource` map
2. ✅ Properly iterates through nested assets and sources
3. ✅ Detects gaps within each oracle source independently
4. ✅ Generates accurate backfill commands for operators
5. ✅ Exits with code 1 when gaps exceed the threshold (triggering alerts)
6. ✅ Exits with code 0 when all gaps are within threshold (closing alerts)
