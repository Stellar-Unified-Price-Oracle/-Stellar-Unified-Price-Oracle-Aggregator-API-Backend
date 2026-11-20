# History Gap Detection - Issues Resolution Summary

## Problem Statement

Four scheduled runs of the `history-gap-detection` workflow failed consecutively:

| Run ID | Date | Time (UTC) |
|--------|------|-----------|
| #42326906522 | Nov 7, 2026 | 01:59 |
| #42184370038 | Nov 6, 2026 | 07:58 |
| #42247988329 | Nov 6, 2026 | 15:58 |
| #42297825970 | Nov 6, 2026 | 21:34 |

All failures exhibited the same pattern: Node.js version incompatibility warnings.

## Root Cause Analysis

### Issue 1: Node.js Deprecation
**Cause**: The workflow was using Node.js 22, which is deprecated on GitHub Actions runners.
- GitHub Actions runners defaulting to Node.js 24 started forcing v24 for jobs using v20/v22
- This caused deprecation warnings and potentially script execution failures
- The detector and backfill scripts could not complete properly

**Impact**: 
- Gap detection reports not generated
- No backfill commands provided to alert issues
- Unclear which assets/time ranges had gaps

## Solutions Implemented

### 1. Workflow Update ✅
**File**: `.github/workflows/history-gap-detection.yml`

**Change**:
```yaml
# Before
NODE_VERSION: '22'

# After
NODE_VERSION: '24'
```

**Why**: Ensures compatibility with current GitHub Actions runners and eliminates deprecation warnings.

### 2. Documentation ✅
**File**: `HISTORY_GAP_FIX_GUIDE.md`

Comprehensive guide covering:
- Workflow re-execution instructions
- Gap report interpretation
- Backfill procedures for each asset
- Troubleshooting checklist
- Configuration tuning

### 3. Helper Script ✅
**File**: `scripts/fix-history-gaps.sh`

Automated script for gap management:
```bash
# Detect gaps only
DATABASE_URL="..." ./scripts/fix-history-gaps.sh

# Detect gaps for specific asset
./scripts/fix-history-gaps.sh --asset BTC

# Auto-backfill all detected gaps
./scripts/fix-history-gaps.sh --backfill

# Custom time window
./scripts/fix-history-gaps.sh --since 2024-10-01 --backfill
```

Features:
- Unified gap detection and backfill flow
- JSON report parsing for automation
- Verification step to confirm gaps are closed
- Clear progress reporting

## Next Steps

### For the DevOps/Data Team

1. **Immediate Action**: Re-run the history gap detection workflow
   ```bash
   gh workflow run history-gap-detection.yml --ref main
   ```

2. **Monitor the Run**: 
   - Check the "Detect gaps" step for the JSON report
   - Note which assets have gaps and their time ranges

3. **Execute Backfills**:
   - Use the provided backfill commands from the report
   - Or use the helper script:
     ```bash
     cd api
     export DATABASE_URL="<history-db-connection>"
     npm run history:backfill -- --asset BTC --from 1728345600 --to 1728349200
     ```

4. **Verify Closure**:
   - Re-run gap detector to confirm gaps are closed
   - The hourly scheduled run will automatically close any open alert issues

### For Future Prevention

1. **Node.js Version Management**
   - Workflow will now track current Actions runner versions
   - Update `NODE_VERSION` in workflows annually when runners change

2. **Monitoring**
   - Gap detection runs hourly automatically
   - Failed runs fail fast without creating false alerts
   - Successful runs automatically close previous alert issues

3. **Maintenance**
   - Review `HISTORY_GAP_FIX_GUIDE.md` as reference documentation
   - Use `scripts/fix-history-gaps.sh` for recurring backfills
   - Check `docs/runbooks/history-gap-alert.md` for operational guidance

## Architecture Overview

```
┌─────────────────────────────────┐
│  history-gap-detection.yml      │
│  (runs hourly via schedule)     │
└──────────────┬──────────────────┘
               │
        ┌──────▼─────────┐
        │ Detect Gaps    │
        │ (exit 0/1/2)   │
        └──────┬─────────┘
               │
        ┌──────▼─────────────┐
        │ Gap Report JSON    │
        │ (alertingGaps[])   │
        └──────┬─────────────┘
               │
        ┌──────▼──────────────────┐
        │ Alert Issue Created     │
        │ (if gaps > threshold)   │
        └────────────────────────┘

Run: backfill-history.ts
    ├─ Read source files (history-<ASSET>.json)
    ├─ Insert records via SQL (ON CONFLICT DO NOTHING)
    ├─ Verify no gaps remain
    └─ Report status

Re-run detector → Exit 0 → Auto-close alerts
```

## Files Changed

```
.github/workflows/history-gap-detection.yml    (updated)
HISTORY_GAP_FIX_GUIDE.md                       (new)
scripts/fix-history-gaps.sh                    (new)
```

## Testing/Validation

The workflow has built-in validation:

1. **Detector Exit Codes**:
   - `0` = Clean (no gaps over threshold)
   - `1` = Gaps detected (opens alert + runs backfill)
   - `2` = Error (DB unreachable, bad params, etc.)

2. **Report Generation**:
   - JSON report written to temp file if `--output` specified
   - Report parsed by alert step to file issues only when valid

3. **Alert Closure**:
   - Successful run (exit 0) closes all open gap alerts
   - Prevents stale/false alerts from lingering

## References

### Scripts
- Gap Detection: `api/scripts/detect-history-gaps.ts`
- Backfilling: `api/scripts/backfill-history.ts`
- Alert Logic: `scripts/history-gap-alert.mjs`

### Documentation
- Full Runbook: `docs/runbooks/history-gap-alert.md`
- Infrastructure: `docs/runbooks/database-issues.md`
- Background: Issue #421 (continuous price_history dataset requirement)

### Related Issues
- #885, #886, #887, #888 (backfill tracking)
- #421 (original gap detection requirement)

---

**Status**: ✅ Ready for re-execution
**Commit**: `547410c` (Fix history gap detection workflow compatibility)
**Date**: 2026-11-20

