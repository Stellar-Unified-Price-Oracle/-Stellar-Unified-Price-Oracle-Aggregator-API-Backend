**Owner:** Data platform
**Review date:** 2026-11-19

# Runbook — `price_history` gap detected

**Severity:** P2 (P1 if a gap covers a consumer-facing VWAP/EMA window that is being actively served)
**Source:** `.github/workflows/history-gap-detection.yml` (hourly), detector `api/scripts/detect-history-gaps.ts`

## What the alert means

The detector found two consecutive snapshots for the same asset more than
`HISTORY_GAP_ALERT_SEC` (default 900s) apart within the scan window
(default 7 days). The issue body lists each asset, the exact range, and a
ready-to-run backfill command.

The workflow opens **one** issue and comments on it on later failing runs. It
only opens or comments when the detector itself exits `1`. These outcomes fail
the run without filing an issue:

| Exit / failure | Meaning | Action |
| :--- | :--- | :--- |
| Install step fails | Dependency or lockfile problem, so the detector never ran | Fix the build (for example, `npm install` to resync `package-lock.json`) |
| Detector exit `2` | Bad `--since`, missing `DATABASE_URL`, or DB unreachable | See [database-issues.md](database-issues.md) |
| Detector exit `1` | Real gap beyond threshold | Follow the steps below |

> History: from 2026-10-20 to 2026-11-19 the alert step ran on any failure, and
> `npm ci` was failing on a stale lockfile (`@stellar-oracle/sdk-bindings`
> missing). That opened 121 "gap detected" issues when no scan had actually run.

## Alert log

Each row records one `price_history gap detected` issue and how it was resolved.
"False positive" means the detector never ran, so no gap was measured and no
backfill applies.

| Issue | Run | Failed step | Detector ran? | Outcome |
| :--- | :--- | :--- | :--- | :--- |
| #901 | [41369390299](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41369390299) (2026-11-02 00:51 UTC) | Install dependencies (`npm ci`: `Missing: @stellar-oracle/sdk-bindings@1.0.0 from lock file`) | No | False positive; no backfill needed. Lockfile resynced and alert gated on detector exit `1`. |

## Diagnose

1. Open the run linked in the issue and read the JSON report in the **Detect gaps** step.
2. Check whether the gap is still growing. If the latest gap ends near "now", the aggregator
   or history writer is down. Use [price-feed-stale.md](price-feed-stale.md) first,
   because backfilling won't help while writes are still failing.
3. Check whether source snapshot files cover the range:
   ```sh
   cd api && npm run history:backfill -- --asset <ASSET> --from <startTs> --to <endTs> --dry-run
   ```
   `0 row(s) would be replayed` means the source files don't cover the gap either. Record it as
   an unrecoverable gap in the issue and stop.

## Remediate

```sh
cd api
export DATABASE_URL=...            # history database, write access
npm run history:backfill -- --asset BTC --from 1763000000 --to 1763003600
npm run history:gaps -- --asset BTC --since 2026-11-12
```

Inserts are idempotent (`ON CONFLICT (asset, source, timestamp) DO NOTHING`), so it's safe
to re-run them. Then re-run the workflow (`workflow_dispatch`). Close the issue once the run passes.

## Tuning

- `HISTORY_EXPECTED_INTERVAL_SEC` (60): the cadence. A gap is anything over 1.5× this value.
- `HISTORY_GAP_ALERT_SEC` (900): the alerting threshold.
- `HISTORY_LOOKBACK_DAYS` (7): the default scan window.

## Rollback

The alert logic lives in `scripts/lib/history-gap-alert.mjs`, and
`scripts/tests/history-gap-alert.test.mjs` covers it. Reverting the workflow
change brings back the old behaviour (a new issue on any failure). It touches
no data or schema.
