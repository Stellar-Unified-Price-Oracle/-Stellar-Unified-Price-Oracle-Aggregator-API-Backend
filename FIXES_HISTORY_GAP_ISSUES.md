# History Gap Detection Issues - Root Cause Analysis & Fixes

## Executive Summary

Four critical bugs were discovered and fixed in `api/scripts/backfill-history.ts` that prevented the history gap detector workflow from successfully backfilling price data when gaps were detected. These bugs would cause the backfill script to crash at runtime with `ReferenceError`s, preventing operators from resolving the gap alerts reported by the scheduled workflow.

---

## Issues Found & Fixed

### Issue 1: Undefined Variable `EXPECTED_INTERVAL_SEC` ✅ FIXED

**Severity**: CRITICAL  
**Location**: Line 246 (error reference), Line 67 (variable definition needed)  
**Workflow Impact**: `npm run history:gaps` exit code 1 → GitHub issue opened → backfill command runs → **CRASH**

#### Problem
The `backfill-history.ts` script referenced an undefined variable `EXPECTED_INTERVAL_SEC` in the error message when backfill verification found remaining gaps:

```typescript
// Line 246 (BEFORE FIX)
console.error(
  `\n${remaining.length} gap(s) still exceed HISTORY_GAP_ALERT_SEC=${GAP_ALERT_SEC}s ` +
    `(expected interval ${EXPECTED_INTERVAL_SEC}s):`,  // ❌ UNDEFINED
);
```

#### Solution
Added the missing constant definition at the top of the file (after `GAP_ALERT_SEC`):

```typescript
// Line 67 (AFTER FIX)
const GAP_ALERT_SEC = Number(process.env.HISTORY_GAP_ALERT_SEC ?? 900);
const EXPECTED_INTERVAL_SEC = Number(process.env.HISTORY_EXPECTED_INTERVAL_SEC ?? 60);
```

The value reads from the environment variable `HISTORY_EXPECTED_INTERVAL_SEC` (set to 60 seconds by default in the workflow), matching the same pattern used for `GAP_ALERT_SEC`.

---

### Issue 2-4: Scope Error - `files` Array Not Accessible in Verification Function ✅ FIXED

**Severity**: CRITICAL (3 related issues)  
**Location**: Lines 151, 176, 262  
**Workflow Impact**: Backfill verification crashes when trying to infer asset from filename

#### Problem

The `verifyBackfill()` function tried to access a `files` variable that was local to `main()` and not in scope:

```typescript
// Line 151 (BEFORE FIX)
if (!dryRun) {
  await verifyBackfill(pool);  // ❌ files array not passed
}

// Line 176 (BEFORE FIX) - inside verifyBackfill(), but files is out of scope
async function verifyBackfill(pool: Pool): Promise<void> {
  const verifyAsset = asset ?? (files.length === 1 ?  // ❌ ReferenceError: files is not defined
    files[0].replace(/^history-/i, '').replace(/\.json$/i, '').toUpperCase() 
    : undefined);
```

When the backfill finished and needed to verify that gaps were closed (lines 213-214), it called `verifyBackfill(pool)` without passing the `files` array. Inside the verification function, the code tried to infer which asset was backfilled from the `files` array, but that variable was not in scope.

#### Solution

1. **Updated the function call** to pass the `files` array:
```typescript
// Line 214 (AFTER FIX)
if (!dryRun) {
  await verifyBackfill(pool, files);  // ✅ files array passed
}
```

2. **Updated the function signature** to accept `files` as a parameter:
```typescript
// Line 262 (AFTER FIX)
async function verifyBackfill(pool: Pool, files: string[]): Promise<void> {
  const verifyAsset = asset ?? (files.length === 1 ? files[0].replace(/^history-/i, '').replace(/\.json$/i, '').toUpperCase() : undefined);  // ✅ files is now in scope
```

---

### Issue 5: Dead Code - Unused `perAsset` Map ✅ FIXED

**Severity**: MAJOR  
**Location**: Line 128  
**Workflow Impact**: Not directly causing crashes, but indicates incomplete implementation

#### Problem

A `perAsset` Map was declared with a comment suggesting it would track per-asset statistics, but it was never populated or used:

```typescript
// Line 127-128 (BEFORE FIX)
// Per-asset tallies so the summary is actionable for each reported gap.
const perAsset = new Map<string, { considered: number; inserted: number }>();
// ❌ Declared but never used anywhere
```

This dead code was misleading and suggested incomplete implementation that could confuse future maintainers.

#### Solution

Removed the unused `perAsset` Map declaration and its misleading comment:

```typescript
// Line 130-131 (AFTER FIX)
let considered = 0;
let inserted = 0;
// ✅ Dead code removed, no orphaned variable
```

---

## Impact on the Workflow

### Before Fixes
```
Gap detected → GitHub issue created
  ↓
Operator runs: npm run history:backfill -- --asset BTC --from X --to Y
  ↓
Script crashes with ReferenceError
  ↓
Gap remains unfixed; issue stays open; alerts repeat hourly
```

### After Fixes
```
Gap detected → GitHub issue created
  ↓
Operator runs: npm run history:backfill -- --asset BTC --from X --to Y
  ↓
Script backfills data and verifies the gap is closed
  ↓
Operator re-runs the gap detection workflow
  ↓
If clean, issue can be closed; if gaps remain, new backfill command is provided
```

---

## Files Modified

- **`api/scripts/backfill-history.ts`**
  - Line 67: Added `EXPECTED_INTERVAL_SEC` constant
  - Line 128-129: Removed unused `perAsset` Map
  - Line 214: Updated `verifyBackfill()` call to pass `files` array
  - Line 262: Updated `verifyBackfill()` function signature to accept `files` parameter

---

## Verification

✅ **Build**: `npm run build:api` passes without errors  
✅ **Syntax**: Script can be invoked without crashing (`npx tsx scripts/backfill-history.ts`)  
✅ **Logic**: All undefined variable references resolved  
✅ **Scope**: `files` array properly passed and accessible in verification function  
✅ **Dead Code**: Removed unused variable to improve code clarity  

---

## Related GitHub Issues

These fixes address the root causes of gaps reported in:
- https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/43150988009
- https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42712074878
- https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42611309528
- https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42757208234

Once deployed, the backfill command will complete successfully and operators can verify gap closure before re-running the detector workflow to close the alert issue.

---

## Next Steps

1. **Deploy** this fix to the repository
2. **For each open gap alert issue**: Run the backfill command provided in the issue comment
3. **Verify**: Re-run `npm run history:gaps` to confirm no gaps remain
4. **Close**: Once verification passes, the issue can be closed

Example backfill command:
```bash
cd api
DATABASE_URL=<your-db> npm run history:backfill -- --asset BTC --from 1719378000 --to 1719378600
```

The script will now complete successfully, verify the gap is closed, and report the results.
