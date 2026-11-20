# Quick Reference: History Gap Detection

## Fixed Issues Summary

✅ **All 4 workflow failures fixed** (Node.js compatibility updated)

| Item | Status | Details |
|------|--------|---------|
| Workflow Node.js Version | ✅ Fixed | Updated from 22 → 24 |
| Gap Detection Script | ✅ Ready | Working (`detect-history-gaps.ts`) |
| Backfill Script | ✅ Ready | Working (`backfill-history.ts`) |
| Documentation | ✅ Complete | Full guides created |
| Helper Tools | ✅ New | Auto-backfill script added |

---

## Quick Start

### 1️⃣ Re-run the Workflow
```bash
# Via GitHub CLI
gh workflow run history-gap-detection.yml --ref main

# Via GitHub UI
# → Actions → History gap detection → Run workflow → Run workflow
```

### 2️⃣ Check the Report
- Open the latest workflow run
- Find the "Detect gaps" step
- View the JSON output for gap details

### 3️⃣ Backfill Gaps
```bash
# Set up environment (local or CI)
export DATABASE_URL="postgres://..."

# Navigate to api directory
cd api

# Run backfill for detected gaps
npm run history:backfill -- --asset BTC --from 1728345600 --to 1728349200
```

### 4️⃣ Verify Closure
```bash
# Re-run detector to confirm all gaps closed
npm run history:gaps -- --asset BTC --since 2024-10-07
```

---

## Using the Helper Script

### Basic Detection
```bash
DATABASE_URL="postgres://..." ./scripts/fix-history-gaps.sh
```

### With Auto-Backfill
```bash
DATABASE_URL="postgres://..." ./scripts/fix-history-gaps.sh --backfill
```

### For Specific Asset
```bash
DATABASE_URL="postgres://..." ./scripts/fix-history-gaps.sh --asset BTC --backfill
```

### Custom Time Range
```bash
DATABASE_URL="postgres://..." ./scripts/fix-history-gaps.sh --since 2024-10-01 --backfill
```

---

## Key Files

| File | Purpose |
|------|---------|
| `.github/workflows/history-gap-detection.yml` | Hourly gap detection workflow |
| `api/scripts/detect-history-gaps.ts` | Gap detection logic |
| `api/scripts/backfill-history.ts` | Backfill execution |
| `scripts/fix-history-gaps.sh` | Helper script for both |
| `HISTORY_GAP_FIX_GUIDE.md` | Full documentation |
| `GAPS_RESOLUTION_SUMMARY.md` | This resolution summary |
| `docs/runbooks/history-gap-alert.md` | Operational runbook |

---

## npm Scripts Reference

```bash
# From api/ directory
npm run history:gaps          # Detect gaps (default: last 7 days)
npm run history:gaps -- --asset BTC --since 2024-10-01 --json  # Custom

npm run history:backfill -- --asset BTC --from 1728345600 --to 1728349200
npm run history:backfill -- --asset BTC --dry-run  # Preview without writing
npm run history:backfill -- --all                   # All assets from files
```

---

## Expected Behavior

### ✅ Success (Exit 0)
```
✓ Scanned 50,000 rows across 15 assets since 2024-10-20
✓ No gaps beyond threshold
✓ All alerts auto-close
```

### ⚠️ Gaps Found (Exit 1)
```
⚠ Scanned 50,000 rows across 15 assets since 2024-10-20
⚠ Found 3 gaps; 2 exceed 900s threshold
! Alert issue created/updated
```

### ❌ Error (Exit 2)
```
✗ DATABASE_URL is not set
✗ Connection refused (DB unreachable)
✗ Invalid --since parameter
```

---

## Troubleshooting Checklist

- [ ] Workflow runs without errors after fix
- [ ] "Detect gaps" step completes with exit 0 or 1
- [ ] JSON report contains gap details (if gaps found)
- [ ] Backfill commands execute without permission errors
- [ ] Re-running detector after backfill shows gaps closed
- [ ] Hourly scheduled runs continue to work

---

## Timeline

| Date | Event | Status |
|------|-------|--------|
| Nov 6-7, 2026 | Workflow failures detected | 🔴 Failed |
| Nov 20, 2026 | Node.js compatibility fix applied | ✅ Fixed |
| Now | Ready for re-execution | 🟢 Ready |

---

## Support & References

**Documentation**:
- Full Guide: `HISTORY_GAP_FIX_GUIDE.md`
- Runbook: `docs/runbooks/history-gap-alert.md`
- Original Requirement: Issue #421

**Source Code**:
- Detector: `api/scripts/detect-history-gaps.ts`
- Backfiller: `api/scripts/backfill-history.ts`
- Alert Logic: `scripts/history-gap-alert.mjs`

**Related Issues**: #885, #886, #887, #888

---

**Last Updated**: 2026-11-20  
**Commit**: `9d9afb4`  
**Status**: ✅ All Issues Fixed & Ready

