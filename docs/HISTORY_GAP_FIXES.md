# History Gap Detection and Fixes

## Overview

The `price_history` table requires continuous data with no gaps exceeding 15 minutes (`HISTORY_GAP_ALERT_SEC=900`). The history gap detection workflow runs hourly and automatically files GitHub issues when gaps are found. This guide explains how to fix them.

## Issue References

Related issues from the alerts:
- Run 41955809693
- Run 42136337865
- Run 42016055744
- Run 42087698872

## Gap Detection Process

The workflow at `.github/workflows/history-gap-detection.yml`:

1. **Runs hourly** via cron or on-demand
2. **Scans** `price_history` for gaps > 15 minutes
3. **Reports gaps** with asset, start/end timestamps, and backfill commands
4. **Files GitHub issues** for alerting gaps
5. **Auto-closes issues** when gaps are backfilled

### Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HISTORY_EXPECTED_INTERVAL_SEC` | 60 | Expected time between snapshots |
| `HISTORY_GAP_ALERT_SEC` | 900 | Gap size that triggers alert (15 min) |
| `HISTORY_DATABASE_URL` | Required | TimescaleDB connection (GitHub secret) |
| `HISTORY_LOOKBACK_DAYS` | 7 | Default scan window |

## Quick Fix Steps

### Step 1: Detect Current Gaps

```bash
# From repository root
cd api
npm run history:gaps
```

This outputs:
- Number of gaps found
- Number exceeding alert threshold
- Details for each gap (asset, timestamps, gap duration)
- Recommended backfill commands

Example output:
```
Scanned 5000 rows across 12 assets since 2026-01-14T00:00:00.000Z
Found 3 gap(s); 1 exceed 900s
  [ALERT] BTC      2026-01-10T12:00:00.000Z -> 2026-01-10T12:30:00.000Z  1800s  (~30 missing)
  [warn ] USDC     2026-01-09T08:15:00.000Z -> 2026-01-09T08:25:00.000Z  600s   (~10 missing)
  [warn ] USDT     2026-01-08T14:45:00.000Z -> 2026-01-08T15:05:00.000Z  1200s  (~20 missing)

1 alerting gap(s) require backfill:
  BTC 2026-01-10T12:00:00.000Z -> 2026-01-10T12:30:00.000Z (1800s)
    npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
```

### Step 2: Backfill the Gap

#### Option A: Backfill with Known Timestamps

```bash
cd api
npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
```

Where:
- `--asset` is the affected asset symbol (BTC, USDC, etc.)
- `--from` is the gap start timestamp (epoch seconds)
- `--to` is the gap end timestamp (epoch seconds)

#### Option B: Dry Run First

Test the backfill without writing to the database:

```bash
cd api
npm run history:backfill -- --asset BTC --dry-run
```

This shows how many rows would be backfilled from source files.

#### Option C: Backfill All Assets

If multiple assets need recovery:

```bash
cd api
npm run history:backfill -- --all
```

### Step 3: Verify the Fix

Re-run gap detection to confirm the gap is closed:

```bash
cd api
npm run history:gaps
```

Expected output when fixed:
```
Scanned 5000 rows across 12 assets since 2026-01-14T00:00:00.000Z
Found 2 gap(s); 0 exceed 900s
No gaps beyond threshold.
```

### Step 4: Auto-Close GitHub Issue

Once the gap is backfilled:

1. The next scheduled gap detection run (hourly at :17) will detect it's clean
2. The GitHub issue will automatically close with a comment
3. The alert is resolved

To re-run manually:

```bash
# Manually trigger the workflow
gh workflow run history-gap-detection.yml
# Or in GitHub UI: Actions → History gap detection → Run workflow
```

## Backfill Data Sources

The `backfill-history.ts` script looks for source data in this order:

1. First positional argument: `npm run history:backfill -- --asset BTC ./path/to/data`
2. Repository `data/` directory
3. `api/data/` directory
4. `services/aggregator/data/` directory

Source files must be named `history-<ASSET>.json` and contain an array of snapshots:

```json
[
  {
    "asset": "BTC",
    "price": "42500",
    "decimals": 8,
    "source": "chainlink",
    "timestamp": 1704864000
  },
  ...
]
```

**Note:** Timestamps are in **epoch seconds**, not milliseconds.

## Troubleshooting

### "No data directory found"

**Cause:** Backfill source files don't exist in expected locations.

**Solutions:**

```bash
# 1. Create data directory with source files
mkdir -p data
# Add history-*.json files to data/

# 2. Or specify directory explicitly
cd api && npm run history:backfill -- --asset BTC ./path/to/my/data

# 3. Or check if aggregator has the files
ls services/aggregator/data/
```

### "No matching history-*.json files"

**Cause:** Wrong filename format or asset symbol case.

**Solutions:**

```bash
# Files must be named exactly: history-<ASSET>.json
ls data/history-*.json

# Check case sensitivity (usually uppercase)
ls data/history-BTC.json data/history-btc.json

# If missing, restore from backups or request from data team
```

### "Gap detection failed: DATABASE_URL is not set"

**Cause:** Missing database connection.

**Solutions:**

```bash
# Set DATABASE_URL for local testing
export DATABASE_URL="postgresql://user:pass@localhost:5432/oracle"

# Or for CI/GitHub Actions: add HISTORY_DATABASE_URL secret
# Settings → Secrets and variables → Actions → HISTORY_DATABASE_URL
```

### "Backfill complete but gaps remain"

**Cause:** Source data doesn't cover the gap range, or range is incorrect.

**Solutions:**

```bash
# 1. Verify the timestamps are correct (epoch seconds, not milliseconds)
node -e "console.log(new Date(1704864000 * 1000).toISOString())"

# 2. Extend the range to include more data
npm run history:backfill -- --asset BTC --from 1704863000 --to 1704866000

# 3. Check source file timestamps
jq '.[] | .timestamp' data/history-BTC.json | sort -n | head -5

# 4. Verify the data exists in source files
jq 'map(select(.timestamp >= 1704864000 and .timestamp <= 1704865800)) | length' data/history-BTC.json
```

### False Positives / "Gap detector exited 1 but lists no gap"

**Cause:** Detector reported gaps but the report is corrupted or empty.

**Solutions:**

```bash
# 1. Check the report file
cat /tmp/gaps.json

# 2. Re-run with JSON output for debugging
cd api && npm run history:gaps -- --json

# 3. If consistently failing, the detector may have a bug
# Report with: npm run history:gaps -- --json > report.json
```

## Automation & Prevention

### Monthly Audit

Run a full audit monthly to catch gaps early:

```bash
# Scan the last 30 days
cd api && npm run history:gaps -- --since "2026-01-01"
```

### Archive Tiers

Historical data older than 1 year is archived to cold storage. Gaps in archived periods require:

1. Restoring from archive
2. Backfilling via `--from`/`--to` range that includes archived period
3. Or requesting data from storage

### Retention Policy

See `docs/DATA_RETENTION_POLICY.md` for archival schedules and cold-storage recovery.

## Performance Notes

- Backfill scans source files sequentially; large files (>100k rows) may take minutes
- Database inserts are batched but still can be slow for massive ranges
- Use `--dry-run` to estimate before committing large backfills

## Related

- [Price History Design](./PRICE_HISTORY_DESIGN.md)
- [Data Retention Policy](./DATA_RETENTION_POLICY.md)
- [Gap Detection Workflow](../.github/workflows/history-gap-detection.yml)
- [Gap Alert Helper](../scripts/history-gap-alert.mjs)

---

**Last Updated:** 2026-01-20  
**Maintainer:** Data Engineering Team
