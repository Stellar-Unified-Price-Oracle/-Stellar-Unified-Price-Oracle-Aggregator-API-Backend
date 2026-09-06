# History backfill & gap detection

Issue #421. Keeps `price_history` continuous and complete so VWAP/EMA consumers
and audits can trust it.

## Gap detection

`api/scripts/detect-history-gaps.ts` (`npm run history:gaps`, run from `api/`)
scans `price_history`, groups snapshots per asset, and flags every interval that
is longer than `1.5 x HISTORY_EXPECTED_INTERVAL_SEC`.

| Env var | Default | Meaning |
| --- | --- | --- |
| `HISTORY_EXPECTED_INTERVAL_SEC` | `60` | expected cadence between snapshots |
| `HISTORY_GAP_ALERT_SEC` | `900` | gap size that escalates to an alert / non-zero exit |
| `HISTORY_LOOKBACK_DAYS` | `7` | window scanned when `--since` is omitted |

```sh
cd api
npm run history:gaps                       # human-readable, last 7 days
npm run history:gaps -- --asset BTC --json  # machine-readable, one asset
npm run history:gaps -- --since 2026-01-01
```

Exit `0` = clean, `1` = a gap exceeded `HISTORY_GAP_ALERT_SEC`, `2` = usage error.

## Alerting

`.github/workflows/history-gap-detection.yml` runs the detector hourly against
`secrets.HISTORY_DATABASE_URL`. A gap over threshold fails the job, which opens a
`data` / `alert` issue with the offending window and the backfill command. Wire
the same script into Prometheus (via a `textfile` collector emitting
`price_history_max_gap_seconds`) if you prefer alerting through Alertmanager.

## Backfill

`api/scripts/backfill-history.ts` (`npm run history:backfill`) replays source
`history-<asset>.json` snapshot files into `price_history`. Inserts are
idempotent through the unique `(asset, source, timestamp)` index.

```sh
cd api
npm run history:backfill -- --asset BTC --from 1719378000 --to 1719378600
npm run history:backfill -- --asset BTC --dry-run
npm run history:backfill -- --all            # replay every source file
```

## Standard recovery loop

1. `npm run history:gaps` reports a gap for asset `X` between `t0` and `t1`.
2. `npm run history:backfill -- --asset X --from t0 --to t1`.
3. `npm run history:gaps -- --asset X` to confirm the gap is closed.
4. If source files do not cover the window, request a re-fetch from the upstream
   provider or accept the gap with a documented note in the audit log.
