# History Gap Alert Runbook

**Severity:** Medium  
**MTTR Target:** 2 hours  
**Automated Recovery:** Partial (detection + alerting; manual backfill)

## Summary

Price history has a gap exceeding the 15-minute alert threshold (`HISTORY_GAP_ALERT_SEC=900`). This breaks downstream VWAP/EMA consumers and audit trails.

---

## Incident Triggered

When:
- The scheduled `history-gap-detection` workflow detects a gap > 900 seconds
- A GitHub issue is automatically filed with asset, timestamps, and backfill commands
- The alert is labeled `data` and `alert`

Example issue title:
```
price_history gap detected (2026-01-20)
```

---

## Quick Response (< 5 min)

### Step 1: Acknowledge the Alert

- [ ] GitHub issue created (auto-labeled `data`, `alert`)
- [ ] Notifications sent to Slack / PagerDuty
- [ ] Post incident acknowledgment: "Investigating history gap for [ASSET]"

### Step 2: Assess Scope

```bash
# From repository root
cd api

# Run gap detection to confirm
npm run history:gaps
```

You should see output like:

```
Found 1 gap(s); 1 exceed 900s
  [ALERT] BTC 2026-01-10T12:00:00Z -> 2026-01-10T12:30:00Z  1800s  (~30 missing)

Backfill with:
  npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
```

Record:
- Affected asset(s)
- Gap start/end timestamps
- Gap duration (seconds)
- Number of missing snapshots

---

## Full Resolution (< 30 min)

### Step 3: Prepare Backfill

Before executing, verify data availability:

```bash
cd api

# Check if source files exist
ls data/history-BTC.json        # or api/data/ or services/aggregator/data/

# Preview what would be backfilled (dry-run)
npm run history:backfill -- --asset BTC --dry-run
```

If dry-run shows 0 rows:
- **Source data is missing**
- Escalate to data retention team
- See "Data Recovery" section below

### Step 4: Execute Backfill

```bash
cd api

# Replace with actual asset/timestamps from alert
npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
```

**Expected output:**

```
history-BTC.json: considered 1450, inserted 1450

Verification for BTC from 1704864000 to 1704865800: 1450 row(s) present
No gaps larger than 900s remain in range.
```

**Success indicators:**
- Rows inserted match expected count
- Verification shows no remaining gaps
- Exit code 0

**If backfill reports remaining gaps:**

See "Troubleshooting" section below.

### Step 5: Confirm Resolution

The gap detection workflow runs automatically every hour at minute :17.

To verify sooner:

```bash
cd api
npm run history:gaps
```

If clean:

```
Found 0 gap(s); 0 exceed 900s
No gaps beyond threshold.
```

**Or:** Manually trigger the CI workflow:

```bash
gh workflow run history-gap-detection.yml
```

The GitHub issue will auto-close once the next clean scan completes.

### Step 6: Document

In the issue, add a comment:

```markdown
## Resolution

**Gap:** BTC 2026-01-10 12:00–12:30 UTC (1800s / 30 snapshots)

**Root Cause:** [Brief description: e.g., "Aggregator process restarted during 30-min maintenance window"]

**Fix Applied:**
```bash
npm run history:backfill -- --asset BTC --from 1704864000 --to 1704865800
```
**Result:** 1450 snapshots restored, no remaining gaps.

**Verified:** Ran `npm run history:gaps` at [timestamp]; clean.
```

---

## Troubleshooting

### Problem: "No data directory found"

**Symptom:**
```
No data directory found. Looked in:
  /repo/data
  /repo/api/data
  /repo/services/aggregator/data
```

**Cause:** Backfill source files missing or misplaced.

**Fix:**

1. Check if files exist elsewhere:
   ```bash
   find /repo -name "history-*.json" -type f
   ```

2. If found, copy to expected location:
   ```bash
   mkdir -p api/data
   cp /path/to/history-BTC.json api/data/
   ```

3. If not found, request from data team:
   - Asset: [BTC]
   - Period: [2026-01-10 12:00–12:30 UTC]
   - Source provider(s): [chainlink, redstone, band, reflector]
   - Format: JSON array of snapshots

4. After obtaining source, retry backfill.

---

### Problem: "No matching history-*.json files"

**Symptom:**
```
No matching history-*.json files in /repo/api/data
```

**Cause:** Filename format incorrect or asset case mismatch.

**Fix:**

```bash
# Files MUST be named: history-<ASSET>.json (uppercase)
ls api/data/

# Should show:
# history-BTC.json
# history-USDC.json
# etc.

# Rename if needed:
mv api/data/history-btc.json api/data/history-BTC.json
```

---

### Problem: "Backfill complete but gaps remain"

**Symptom:**
```
2 gap(s) larger than 900s remain:
  1704864000 -> 1704865000 (1000s)
  1704865100 -> 1704866000 (900s)
```

**Cause:** Range was too narrow or source data incomplete.

**Fix:**

1. Extend the range by 10% on each side:
   ```bash
   # Original: --from 1704864000 --to 1704865800
   # Extended: --from 1704863400 --to 1704866400
   npm run history:backfill -- --asset BTC --from 1704863400 --to 1704866400
   ```

2. If still gaps, verify source data:
   ```bash
   # Check what timestamps exist in source
   jq -r '.[].timestamp' api/data/history-BTC.json | sort -n | uniq | wc -l
   
   # See the range:
   jq -r '.[].timestamp' api/data/history-BTC.json | sort -n | head -1
   jq -r '.[].timestamp' api/data/history-BTC.json | sort -n | tail -1
   ```

3. If source is incomplete, request extended period from data team.

---

### Problem: "Gap detection failed: DATABASE_URL is not set"

**Symptom:**
```
DATABASE_URL is not set
```

**Cause:** Environment not configured.

**Fix for Local Testing:**

```bash
# Set the environment variable
export DATABASE_URL="postgresql://user:password@localhost:5432/oracle"

# Or in .env file
echo "DATABASE_URL=postgresql://..." >> api/.env

# Retry
cd api && npm run history:gaps
```

**Fix for GitHub Actions:**

The workflow uses the `HISTORY_DATABASE_URL` secret. To verify:

```bash
# Owner must set this in repo settings:
# Settings → Secrets and variables → Actions → HISTORY_DATABASE_URL
```

Contact the repository owner if the secret is missing.

---

### Problem: "Timestamps seem wrong"

**Symptom:** Gap shows year 2050 or 1970; timestamps don't convert correctly.

**Cause:** Source data has milliseconds instead of seconds, or corrupted values.

**Fix:**

```bash
# Check a sample timestamp from source
jq '.[0].timestamp' api/data/history-BTC.json

# If it's > 1e13, it's milliseconds. Convert:
jq 'map(.timestamp |= (if . > 1e13 then . / 1000 else . end))' \
  api/data/history-BTC.json > history-BTC-fixed.json
mv history-BTC-fixed.json api/data/history-BTC.json

# Verify
jq '.[0] | {timestamp, date: (.timestamp * 1000 | todateiso8601)}' \
  api/data/history-BTC.json
```

---

## Prevention

### Pre-Incident

- [ ] Ensure aggregator process is healthy (`npm run deploy-aggregator:healthcheck`)
- [ ] Verify database TTL settings are correct
- [ ] Confirm backup snapshots are being written
- [ ] Monitor oracle provider uptime

### Post-Incident (Within 48 hrs)

- [ ] Root cause analysis (see template below)
- [ ] Identify if this was an outlier or systemic issue
- [ ] If systemic: file an engineering issue for the dev team
- [ ] Update prevention runbook if new trigger was discovered

---

## Root Cause Analysis Template

Copy into the issue after incident closes:

```markdown
## Post-Incident Review

**Incident ID:** [issue #]  
**Duration:** [HH:MM from first alert to resolution]  
**Impact:** [brief description]  

### Root Cause

[What caused the gap? Examples:]
- Aggregator process crashed 12:00–12:30 UTC
- Network partition to oracle provider
- Database connection timeout during maintenance window
- Disk space exhaustion on data directory

### Detection

- Detected by: Scheduled gap detection workflow (hourly at :17)
- TTM (Time to Mitigation): [minutes from first alert]

### Fix

[What was done to resolve:]
- Backfilled 1450 snapshots from historical cache
- Restarted aggregator service
- etc.

### Follow-Up

**Action Items:**
- [ ] Action 1 (assignee, deadline)
- [ ] Action 2 (assignee, deadline)
- [ ] etc.

---
```

---

## Escalation

### If Backfill Fails After Multiple Retries

1. **Notify:** Data Engineering Team + On-call Engineer
2. **Impact:** History consumers are stalled for this asset
3. **Options:**
   - Request archived snapshots from cold storage (24–72 hr delay)
   - Accept the gap (audit trail degradation)
   - Mark period as "data unavailable" in API response

### If Multiple Assets Show Simultaneous Gaps

1. **Scope:** System-wide issue (not isolated)
2. **Suspects:**
   - Database outage / replication lag
   - Aggregator service hung / crashed
   - Disk full or permission issue
3. **Actions:**
   - Page on-call engineer
   - Check aggregator logs: `docker logs aggregator`
   - Check database health: `psql $DATABASE_URL -c "SELECT 1;"`
   - Check disk: `df -h /data`

---

## Links

- **Gap Detection Code:** `api/scripts/detect-history-gaps.ts`
- **Backfill Code:** `api/scripts/backfill-history.ts`
- **Workflow Definition:** `.github/workflows/history-gap-detection.yml`
- **Alert Helper:** `scripts/history-gap-alert.mjs`
- **Design Doc:** `docs/PRICE_HISTORY_DESIGN.md`

---

**Last Updated:** 2026-01-20  
**Owner:** Data Engineering  
**Review Cycle:** Quarterly
