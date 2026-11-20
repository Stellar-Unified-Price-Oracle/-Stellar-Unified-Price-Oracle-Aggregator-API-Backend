# Fix: Eliminate False price_history Gap Alerts

## Problem Statement

Four GitHub Actions workflow runs (#885-#888) reported history gaps exceeding the 900-second alert threshold. Investigation revealed these were **false positives** caused by the gap detector comparing timestamps aggregated across multiple price sources instead of evaluating gaps per-source.

## Root Cause

The `price_history` table stores prices from multiple independent sources:
- Chainlink (updates ~60s)
- Redstone (updates ~120s)
- Band Protocol (updates ~90s)
- Reflector (updates on its schedule)

Each source operates independently with its own cadence. The gap detector was mixing timestamps from all sources when checking for gaps, creating false alerts when comparing timestamps across different sources.

### Example

Given this data:
```sql
asset=BTC, source=chainlink,  timestamp=1000
asset=BTC, source=chainlink,  timestamp=1060  (60s apart - OK)
asset=BTC, source=redstone,   timestamp=1050  (Redstone update)
asset=BTC, source=redstone,   timestamp=1200  (150s apart - OK for redstone)
```

**Old logic (buggy):**
- Sorted: [1000, 1050, 1060, 1200]
- Gap check: 1000→1050=50s ✓, 1050→1060=10s ✓, 1060→1200=140s ✗ **FALSE ALERT**

**New logic (fixed):**
- Chainlink: [1000, 1060] → 60s ✓
- Redstone: [1050, 1200] → 150s ✓ (acceptable for redstone)
- No alerts

## Solution

Modified the gap detector to:
1. Query the `source` column in addition to asset and timestamp
2. Group results by (asset, source) pairs
3. Only check for gaps between consecutive timestamps from the **same source**

## Files Changed

### `api/scripts/detect-history-gaps.ts`
- Updated SQL query to SELECT and ORDER BY source
- Changed data structure from `Map<asset, timestamp[]>` to `Map<asset, Map<source, timestamp[]>>`
- Modified gap detection loop to iterate per-source

### `api/tests/history-gap-detection.test.ts`
- Updated test helper function with per-source logic
- Added source column to test table and all test data insertions
- Added new test case for multi-source staggered updates

## Impact

- ✅ Eliminates false alerts from normal multi-source operation
- ✅ Real gaps in individual sources are still detected
- ✅ No schema changes required
- ✅ Backward compatible
- ✅ No performance impact

## Verification

```bash
# Run tests
npm run test -- api/tests/history-gap-detection.test.ts

# Verify script runs
cd api
npm run history:gaps
```

## Related Issues
- Issues: #885, #886, #887, #888 (false alert runs)
- Issue #421: Original gap detection requirement
- Workflow: `.github/workflows/history-gap-detection.yml`
