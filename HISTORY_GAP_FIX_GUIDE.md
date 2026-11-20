# History Gap Detection - Fix Guide

## Summary of Issues

Four workflow runs of `history-gap-detection` have failed:
- Run #42326906522 (Nov 7, 2026 01:59)
- Run #42184370038 (Nov 6, 2026 07:58)
- Run #42247988329 (Nov 6, 2026 15:58)
- Run #42297825970 (Nov 6, 2026 21:34)

All failed with similar error patterns related to Node.js deprecation warnings.

## Root Causes & Fixes Applied

### 1. **Node.js Version Deprecation (FIXED)**
   - **Issue**: Workflow was using Node.js 22, which is deprecated on GitHub Actions
   - **Fix**: Updated `.github/workflows/history-gap-detection.yml` to use Node.js 24
   - **Commit**: Update NODE_VERSION to 24 for GitHub Actions compatibility

### 2. **Missing Gap Report Details**
   - **Issue**: The workflow output pages don't show detailed gap data
   - **Root Cause**: Likely due to Node.js version forcing, which prevented proper script execution
   - **Fix**: With Node.js 24 update, the detector script should now run properly and generate reports

## What to Do Now

### Step 1: Re-run the Workflow
Manually trigger the history gap detection workflow to generate the proper gap reports:

```bash
gh workflow run history-gap-detection.yml --ref main
```

Or via GitHub UI:
1. Go to: https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/workflows/history-gap-detection.yml
2. Click "Run workflow" > "Run workflow" button
3. Leave inputs blank (uses defaults: last 7 days)

### Step 2: Check the Workflow Output
Once the workflow completes:
1. Open the run details
2. Find the **"Detect gaps"** step
3. Check the JSON report in the step output for gap details

The report will show:
```json
{
  "scannedAssets": N,
  "scannedRows": M,
  "windowStart": "ISO-8601 timestamp",
  "alertingGaps": [
    {
      "asset": "BTC",
      "startTs": 1728345600,
      "endTs": 1728349200,
      "gapSeconds": 3600,
      "missingSnapshots": 60,
      "startIso": "2024-10-07T16:00:00.000Z",
      "endIso": "2024-10-07T17:00:00.000Z",
      "backfillCommand": "npm run history:backfill -- --asset BTC --from 1728345600 --to 1728349200"
    }
  ]
}
```

### Step 3: Backfill Each Gap

For each gap reported in `alertingGaps`, run the backfill command from the `api/` directory:

```bash
cd api
export DATABASE_URL="<your-history-database-url>"

# Example for BTC gap from timestamps 1728345600 to 1728349200
npm run history:backfill -- --asset BTC --from 1728345600 --to 1728349200

# Verify the backfill closed the gap
npm run history:gaps -- --asset BTC --since 2024-10-07
```

### Step 4: Verify Backfills

After backfilling all gaps, re-run the workflow to confirm:

```bash
gh workflow run history-gap-detection.yml --ref main
```

The workflow should now:
1. Detect no gaps exceeding the 900-second threshold
2. Exit with code 0 (success)
3. If any open gap alerts exist, automatically close them

## Understanding the Scripts

### Detect History Gaps (`api/scripts/detect-history-gaps.ts`)

**Usage:**
```bash
npm run history:gaps [--asset BTC] [--since 2026-01-01] [--json] [--output gaps.json]
```

**Parameters:**
- `--asset <ASSET>`: Filter to a specific asset (optional)
- `--since <ISO-DATE>`: Scan from this date (default: 7 days ago)
- `--json`: Output JSON instead of human-readable format
- `--output <FILE>`: Write JSON report to a file

**Environment Variables:**
- `DATABASE_URL` (required): Connection string to price_history database
- `HISTORY_EXPECTED_INTERVAL_SEC`: Expected price update cadence (default: 60 seconds)
- `HISTORY_GAP_ALERT_SEC`: Gap threshold for alerts (default: 900 seconds / 15 minutes)
- `HISTORY_LOOKBACK_DAYS`: Default scan window (default: 7 days)

**Exit Codes:**
- `0`: No gaps exceeded alert threshold (clean)
- `1`: One or more gaps exceeded threshold (needs backfill)
- `2`: Error (DB unreachable, bad parameters, etc.)

### Backfill History (`api/scripts/backfill-history.ts`)

**Usage:**
```bash
# Backfill specific asset and time range
npm run history:backfill -- --asset BTC --from 1728345600 --to 1728349200

# Dry-run (show what would be backfilled without writing)
npm run history:backfill -- --asset BTC --from 1728345600 --to 1728349200 --dry-run

# Backfill all assets from all available history-*.json files
npm run history:backfill -- --all
```

**Parameters:**
- `--asset <ASSET>`: Required (unless `--all` specified)
- `--from <TIMESTAMP>`: Start time as epoch seconds or ISO-8601 (optional)
- `--to <TIMESTAMP>`: End time as epoch seconds or ISO-8601 (optional)
- `--dry-run`: Preview what would be inserted without committing
- `--all`: Backfill all assets from all history files

**Data Source:**
- Reads from `history-<ASSET>.json` files in:
  1. Directory passed as positional arg
  2. `data/` directory at repo root
  3. `api/data/` directory
  4. `services/aggregator/data/` directory

**File Format:**
```json
[
  {
    "asset": "BTC",
    "price": "45000.50",
    "decimals": 8,
    "source": "chainlink",
    "timestamp": 1728345600
  },
  ...
]
```

## Automation & Monitoring

### Hourly Detection
The workflow runs automatically every hour (`:17` past the hour UTC). It opens/updates an issue if gaps are found.

### Manual Override
For `--since` values other than the default 7 days, use workflow dispatch:
```bash
gh workflow run history-gap-detection.yml \
  --ref main \
  -f since="2024-10-01"
```

### Alert Closure
A successful detector run (exit 0) automatically closes all open gap alerts.

## Troubleshooting

### "DATABASE_URL is not set"
- Ensure the `HISTORY_DATABASE_URL` GitHub secret is configured
- For local testing: `export DATABASE_URL="postgres://..."`

### "No matching history-*.json files in data/"
- Backfill source files must exist with naming pattern `history-<ASSET>.json`
- These files are gitignored; they must be provided separately or restored from backup

### "No gaps beyond threshold" but workflow still failing
- Check the **Detect gaps** step for exit code `2` (error)
- Look for connection errors or timeout messages
- Verify database credentials and network access

### Gaps persist after backfill
- Verify source files cover the entire gap time range
- Use `--dry-run` first to confirm records would be inserted
- Check for permission errors writing to the database

## Configuration Tuning

To adjust alert sensitivity, update in `.github/workflows/history-gap-detection.yml`:

```yaml
env:
  HISTORY_EXPECTED_INTERVAL_SEC: '60'    # Expected seconds between snapshots
  HISTORY_GAP_ALERT_SEC: '900'           # Alert threshold (15 minutes)
```

And in `api/.env`:
```bash
HISTORY_LOOKBACK_DAYS=7                  # Default scan window
```

## References

- Detector: `api/scripts/detect-history-gaps.ts`
- Backfiller: `api/scripts/backfill-history.ts`
- Alert logic: `scripts/history-gap-alert.mjs`
- Workflow: `.github/workflows/history-gap-detection.yml`
- Runbook: `docs/runbooks/history-gap-alert.md`
- Issue tracker: #421, #885, #886, #887, #888

