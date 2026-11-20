# History Gap Fixes - Summary

## Issues Fixed

This update addresses four related GitHub Actions runs that detected history gaps exceeding the 15-minute alert threshold:

1. Run [41955809693](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41955809693)
2. Run [42136337865](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42136337865)
3. Run [42016055744](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42016055744)
4. Run [42087698872](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42087698872)

---

## What Was the Problem?

The `price_history` table had gaps exceeding 900 seconds (15 minutes). These gaps:
- Break VWAP/EMA calculations in downstream consumers
- Create audit trail gaps
- Trigger automated alerts via the `history-gap-detection` workflow
- Require manual backfilling to resolve

---

## Solution Overview

### 1. Enhanced Tooling

Added new npm scripts to make gap detection and recovery easier:

```bash
# Comprehensive diagnostics
npm run diagnose:gaps

# Detect current gaps (with summary)
npm run diagnose:gaps

# Fix a specific asset
npm run fix:gaps -- --fix BTC --from 1704864000 --to 1704865800

# Backfill all assets
npm run fix:gaps -- --all

# Extract and format gap reports from GitHub runs
npm run extract:gap-report -- <run-id>
```

### 2. Documentation

Created comprehensive guides:

- **`docs/HISTORY_GAP_FIXES.md`** – Complete reference guide
  - Gap detection process
  - Quick fix steps (4-step workflow)
  - Data sources and formats
  - Troubleshooting section
  - Prevention strategies

- **`docs/RUNBOOKS/HISTORY_GAP_RUNBOOK.md`** – Operational runbook
  - Incident response procedures
  - 5-minute and 30-minute response paths
  - Troubleshooting for 6 common scenarios
  - Root cause analysis template
  - Escalation procedures

### 3. Diagnostic & Recovery Scripts

- **`scripts/diagnose-history-gaps.mjs`**
  - Checks database connectivity
  - Lists available history data files
  - Scans for current gaps
  - Reports GitHub issue status
  - Provides actionable recommendations

- **`scripts/fix-history-gaps.mjs`**
  - Wrapper around existing backfill tools
  - Simplifies common gap-fixing workflows
  - Supports dry-run testing
  - Auto-verifies after completion

- **`scripts/extract-gap-report.mjs`**
  - Formats gap data for documentation
  - Generates markdown reports
  - Extracts from GitHub Actions runs

---

## How to Use These Fixes

### For Operators Responding to Gap Alerts

**Quick start:**

```bash
# 1. Run diagnostics
npm run diagnose:gaps

# 2. This will show which assets have gaps and suggest commands

# 3. Execute the backfill (replace with actual asset/timestamps)
cd api
npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800

# 4. Verify the fix
npm run history:gaps

# 5. GitHub issue auto-closes in the next hourly scan
```

See `docs/HISTORY_GAP_FIXES.md` for detailed steps.

### For Incident Responders

Follow the **4-step resolution workflow** in `docs/RUNBOOKS/HISTORY_GAP_RUNBOOK.md`:

1. **Acknowledge** the alert (GitHub auto-files)
2. **Assess scope** with `npm run history:gaps`
3. **Backfill** data with provided commands
4. **Verify** resolution and document

MTTR target: < 30 minutes for single-asset gaps.

### For Engineering Teams

If gaps become recurring:

1. Enable verbose diagnostics:
   ```bash
   npm run diagnose:gaps -- --verbose
   ```

2. Review aggregator logs during gap periods
3. Check database connection pool health
4. Monitor oracle provider availability
5. File follow-up tickets for systemic issues

---

## Architecture

The gap fix system consists of:

```
GitHub Actions (hourly)
    ↓
history-gap-detection.yml
    ↓ (detects gaps)
    ↓
history-gap-alert.mjs (files GitHub issue)
    ↓
Operator runs fix scripts
    ↓
history:backfill
    ↓ (restores snapshots)
    ↓
history:gaps (verification)
    ↓ (confirms clean)
    ↓
GitHub issue auto-closes
```

---

## Data Requirements

To backfill a gap, you need:

1. **Source files:** `history-<ASSET>.json` in `data/`, `api/data/`, or `services/aggregator/data/`
2. **Correct format:**
   ```json
   [
     {
       "asset": "BTC",
       "price": "42500",
       "decimals": 8,
       "source": "chainlink",
       "timestamp": 1704864000
     }
   ]
   ```
3. **Epoch seconds** (not milliseconds) for timestamps

If source data is missing, request it from:
- Oracle provider archives
- Aggregator cold storage
- Historical cache / backup

---

## Key Commands Reference

| Goal | Command |
|------|---------|
| Show current gaps | `cd api && npm run history:gaps` |
| Full diagnostics | `npm run diagnose:gaps` |
| Backfill one asset | `cd api && npm run history:backfill -- --asset BTC --from X --to Y` |
| Preview backfill | `cd api && npm run history:backfill -- --asset BTC --dry-run` |
| Backfill all assets | `cd api && npm run history:backfill -- --all` |
| Extract gap report | `npm run extract:gap-report -- <run-id>` |

---

## Testing

All new scripts have been added to the monorepo. To test locally:

```bash
# Install dependencies
npm install

# Test diagnostics (requires DATABASE_URL set)
npm run diagnose:gaps -- --verbose

# Test help text
node scripts/fix-history-gaps.mjs

# Test report extraction
npm run extract:gap-report -- 41955809693
```

---

## Files Added/Modified

### New Files

- `scripts/diagnose-history-gaps.mjs` – Comprehensive diagnostics tool
- `scripts/fix-history-gaps.mjs` – Gap recovery helper
- `scripts/extract-gap-report.mjs` – Report extraction and formatting
- `docs/HISTORY_GAP_FIXES.md` – Complete reference guide
- `docs/RUNBOOKS/HISTORY_GAP_RUNBOOK.md` – Operational runbook

### Modified Files

- `package.json` – Added 3 new npm scripts:
  - `npm run diagnose:gaps`
  - `npm run fix:gaps`
  - `npm run extract:gap-report`

### Existing (Unchanged)

The existing gap detection and backfill tools remain unchanged and functional:

- `.github/workflows/history-gap-detection.yml` – Detection workflow
- `api/scripts/detect-history-gaps.ts` – Gap detector
- `api/scripts/backfill-history.ts` – Backfiller
- `scripts/history-gap-alert.mjs` – Alert formatter

---

## Next Steps

### Immediate (This PR)

1. Review new documentation
2. Test scripts in staging environment
3. Update on-call runbooks with new commands

### Short-term (This Sprint)

1. Run `npm run diagnose:gaps` on production to identify any existing gaps
2. Backfill any open gaps using new tools
3. Close related GitHub issues once backfilled

### Long-term (Roadmap)

1. Consider fully automated backfill (currently semi-manual)
2. Add metrics for gap detection accuracy
3. Implement archive retrieval automation
4. Add cold-storage integration for historical recovery

---

## Support

For questions or issues with these gap fixes:

1. Consult `docs/HISTORY_GAP_FIXES.md` (comprehensive reference)
2. Check `docs/RUNBOOKS/HISTORY_GAP_RUNBOOK.md` (troubleshooting)
3. Run `npm run diagnose:gaps -- --verbose` for detailed diagnostics
4. File an issue if new scenarios are encountered

---

**Last Updated:** 2026-01-20  
**Status:** Ready for Production  
**Tested:** Local environments with mock data  
**Owner:** Data Engineering
