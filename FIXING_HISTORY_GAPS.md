# Fixing History Gaps – Comprehensive Guide

## Quick Start

If you received a GitHub issue about history gaps, follow these 4 quick steps:

### Step 1: Diagnose

```bash
npm run diagnose:gaps
```

This outputs:
- Current gap status
- Affected assets
- Recommended backfill commands

### Step 2: Run Backfill

```bash
cd api
npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
```

(Replace `BTC`, `1704864000`, and `1704865800` with values from the GitHub issue.)

### Step 3: Verify

```bash
cd api
npm run history:gaps
```

Expected output: `No gaps beyond threshold.`

### Step 4: Wait for Auto-Close

The GitHub issue will automatically close within one hour when the next scheduled gap detection run confirms the fix.

---

## Background

### What Are History Gaps?

`price_history` table snapshots should occur every 60 seconds. A "gap" is a period where no snapshot was recorded for longer than expected. Gaps over 15 minutes (`HISTORY_GAP_ALERT_SEC=900`) trigger alerts.

### Why Do They Matter?

- Downstream DeFi protocols use VWAP/EMA calculations that require continuous data
- Audit trails and compliance reporting need completeness
- Missing data degrades price quality metrics

### How Are They Detected?

A scheduled GitHub Actions workflow runs hourly:

```mermaid
Every hour (at :17)
  ↓
history-gap-detection.yml
  ↓
detect-history-gaps.ts (scans last 7 days of price_history)
  ↓
Gaps > 900 seconds found?
  ├─ YES → File GitHub issue (auto-labeled "data", "alert")
  └─ NO  → Close any open issues
```

---

## Issues Covered by This Update

This comprehensive solution addresses four history gap alerts:

| Run | Link |
|-----|------|
| Run 1 | [41955809693](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41955809693) |
| Run 2 | [42136337865](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42136337865) |
| Run 3 | [42016055744](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42016055744) |
| Run 4 | [42087698872](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42087698872) |

Each detected one or more gaps that require backfilling.

---

## New Tools

### 1. Diagnostics

```bash
npm run diagnose:gaps
```

**What it does:**
- ✅ Checks database connectivity
- ✅ Lists available history data files
- ✅ Scans for current gaps (all assets)
- ✅ Shows GitHub issue status
- ✅ Recommends next actions

**Example output:**
```
🔌 Database connectivity... ✅
📁 Found 12 history data file(s)
🔍 Scanning for current gaps...
⚠️  Found 1 alerting gap(s)
  BTC: 1800s (30 missing snapshots)
📍 Found 0 open gap alert issues

📊 Summary:
1 gap(s) need backfilling

Recommended next steps:
  npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
```

### 2. Gap Fixing

```bash
npm run fix:gaps -- --fix BTC --from 1704864000 --to 1704865800
```

**What it does:**
- ✅ Validates inputs
- ✅ Finds source data files
- ✅ Backfills database
- ✅ Verifies no remaining gaps
- ✅ Re-runs gap detection

**Options:**

| Option | Purpose |
|--------|---------|
| `--fix <ASSET>` | Backfill specific asset |
| `--from <ts>` | Start timestamp (epoch seconds) |
| `--to <ts>` | End timestamp (epoch seconds) |
| `--dry-run` | Preview without writing |
| `--all` | Backfill all assets |

### 3. Report Extraction

```bash
npm run extract:gap-report -- 41955809693
```

**What it does:**
- ✅ Formats gap data for documentation
- ✅ Generates markdown tables
- ✅ Summarizes affected assets
- ✅ Lists backfill commands

---

## Documentation

### For Everyone: Quick Reference

→ **`HISTORY_GAP_FIXES.md`**

- Gap detection overview
- 4-step quick fix guide
- Data format requirements
- Troubleshooting (6 scenarios)
- Prevention strategies

**Read this if:** You need to quickly understand and fix a gap.

### For Operators: Runbook

→ **`docs/RUNBOOKS/HISTORY_GAP_RUNBOOK.md`**

- Incident response procedures
- 5-minute and 30-minute response paths
- Detailed troubleshooting
- Root cause analysis template
- Escalation criteria

**Read this if:** You're on-call and need step-by-step instructions.

### For Engineers: Implementation Guide

→ **`HISTORY_GAP_FIXES_SUMMARY.md`**

- Architecture overview
- Files added/modified
- Integration points
- Testing approach
- Long-term roadmap

**Read this if:** You're debugging or enhancing the gap fix system.

---

## Typical Workflow

### Scenario: Gap Alert Received

```
1. GitHub issue filed automatically:
   [data] [alert] price_history gap detected (2026-01-20)

2. You see Slack/PagerDuty notification
   ↓

3. Run diagnostics:
   npm run diagnose:gaps
   
   Output:
   ⚠️  Found 1 alerting gap(s)
     BTC: 1800s (30 missing snapshots)
   ↓

4. Execute backfill (copy from diagnostic output):
   cd api
   npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
   
   Output:
   history-BTC.json: considered 1450, inserted 1450
   Verified: no gaps > 900s remain
   ✅ Exit code 0
   ↓

5. Verify resolution:
   cd api
   npm run history:gaps
   
   Output:
   No gaps beyond threshold.
   ✅ Exit code 0
   ↓

6. Wait for auto-close:
   Scheduled workflow runs at next :17 minute mark
   Gap detection passes
   GitHub issue auto-closes with comment
   ↓

7. Document (comment on issue):
   Gap: BTC 2026-01-10 12:00–12:30 UTC
   Root cause: Aggregator restart during maintenance
   Fixed via: npm run history:backfill --asset BTC --from X --to Y
   Verified: npm run history:gaps (clean)
```

### Scenario: Data Not Found

If `npm run history:backfill` says "No data directory found":

```bash
1. Check where data files are:
   find /repo -name "history-*.json" -type f

2. Copy to expected location:
   mkdir -p api/data
   cp /path/to/history-BTC.json api/data/

3. Retry backfill:
   npm run history:backfill -- --asset BTC --from X --to Y
```

If no data files exist anywhere:

```bash
1. Request from data team:
   - Asset: BTC
   - Period: 2026-01-10 12:00–12:30 UTC (1704864000–1704865800)
   - Format: JSON array of snapshots (see docs for schema)

2. Once received, place in api/data/ and retry
```

---

## Command Reference

| Task | Command |
|------|---------|
| **Diagnose gaps** | `npm run diagnose:gaps` |
| **Detect all gaps** | `cd api && npm run history:gaps` |
| **Backfill one asset** | `cd api && npm run history:backfill -- --asset BTC --from X --to Y` |
| **Dry-run backfill** | `cd api && npm run history:backfill -- --asset BTC --dry-run` |
| **Backfill all** | `cd api && npm run history:backfill -- --all` |
| **Extract gap report** | `npm run extract:gap-report -- <run-id>` |
| **Verbose diagnostics** | `npm run diagnose:gaps -- --verbose` |
| **Run on-demand detection** | `gh workflow run history-gap-detection.yml` |
| **Test gap tools** | `node scripts/test-gap-tools.mjs --skip-db` |

---

## Testing Locally

### Prerequisites

```bash
# Install dependencies
npm install

# Set database URL (required for most tests)
export DATABASE_URL="postgresql://user:pass@localhost:5432/oracle"
```

### Test Suite

```bash
# Test that all gap tools are installed correctly
node scripts/test-gap-tools.mjs --skip-db

# Full diagnostics (requires DATABASE_URL)
npm run diagnose:gaps -- --verbose

# Dry-run a backfill (requires source data and DATABASE_URL)
cd api && npm run history:backfill -- --asset BTC --dry-run
```

---

## Troubleshooting

### "DATABASE_URL is not set"

```bash
# Set the environment variable
export DATABASE_URL="postgresql://user:pass@localhost:5432/oracle"

# Or add to api/.env
echo "DATABASE_URL=..." >> api/.env

# Retry
npm run diagnose:gaps
```

### "No data directory found"

```bash
# Create the data directory
mkdir -p api/data

# Copy or download history files
cp /source/history-BTC.json api/data/

# Verify
ls api/data/history-*.json

# Retry backfill
cd api && npm run history:backfill -- --asset BTC --from X --to Y
```

### "No gaps beyond threshold" but issue still open

```bash
# The GitHub issue auto-closes on the next hourly scan (:17 past)
# To close immediately:
gh workflow run history-gap-detection.yml

# Or wait up to 1 hour for automatic closure
```

### Backfill shows remaining gaps

```bash
# Extend the time range and retry
# Original: --from 1704864000 --to 1704865800
# Extended: --from 1704863000 --to 1704866600

cd api
npm run history:backfill -- --asset BTC --from 1704863000 --to 1704866600
```

For more troubleshooting, see `HISTORY_GAP_FIXES.md`.

---

## Architecture

```
Detection Layer
├─ history-gap-detection.yml (scheduled workflow)
├─ detect-history-gaps.ts (scans database)
└─ history-gap-alert.mjs (files GitHub issues)

Fixing Layer
├─ backfill-history.ts (restores snapshots from files)
├─ diagnose-history-gaps.mjs (health check)
└─ fix-history-gaps.mjs (user-friendly wrapper)

Data Layer
├─ price_history table (TimescaleDB)
├─ history-<ASSET>.json files (source snapshots)
└─ Cold storage (archived > 1 year)

GitHub Integration
├─ Auto-file issue on gap > 900s
├─ Auto-close when gap closes
└─ Comment with backfill commands
```

---

## FAQ

**Q: How often does gap detection run?**
A: Hourly at :17 past the hour. Triggered manually via GitHub Actions or AWS Lambda.

**Q: Can I backfill past data from cold storage?**
A: Yes, but it requires requesting data from cold storage (24–72 hr delay). See docs for procedure.

**Q: What if multiple assets have gaps?**
A: Run separate backfill commands for each asset, or use `--all` to backfill from available files.

**Q: Can I automate gap fixing?**
A: The detection and alerting are automated. Backfilling is semi-manual (requires source data). Full automation is on the roadmap.

**Q: What's the MTTR (mean time to repair)?**
A: < 5 minutes if source data is available. With cold storage retrieval: 24–72 hours.

**Q: Will the GitHub issue auto-close?**
A: Yes, after the next clean gap detection scan (within 1 hour if run on schedule).

---

## Related Links

- [Gap Detection Source](api/scripts/detect-history-gaps.ts)
- [Backfill Source](api/scripts/backfill-history.ts)
- [Alert Formatter](scripts/history-gap-alert.mjs)
- [Detection Workflow](.github/workflows/history-gap-detection.yml)
- [Full Guide](HISTORY_GAP_FIXES.md)
- [Runbook](docs/RUNBOOKS/HISTORY_GAP_RUNBOOK.md)
- [Summary](HISTORY_GAP_FIXES_SUMMARY.md)

---

**Last Updated:** 2026-01-20  
**Version:** 1.0  
**Status:** Production-ready
