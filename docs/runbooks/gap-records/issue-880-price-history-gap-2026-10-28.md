# Gap record: `price_history` gap detected (issue #880, 2026-10-28)

**Source issue:** #880 `price_history gap detected (2026-10-28)`
**Alert run:** https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/40786191550
**Threshold:** `HISTORY_GAP_ALERT_SEC=900`
**Runbook:** [history-gap-alert.md](../history-gap-alert.md)

## Recovery status

| Field | Value |
| :--- | :--- |
| Asset(s) in the gap | Not recorded in the alert text. Read the **Detect gaps** step JSON in the run above. |
| Gap window (`--from` / `--to`) | Not recorded in the alert text. |
| Dry run (`history:backfill --dry-run`) | Not yet run. |
| Backfill applied | No. |
| Gap re-check (`history:gaps --since`) | Not yet run. |
| Workflow re-run confirms closure | No. |

## Steps to close

```sh
cd api
export DATABASE_URL=...            # history database, write access
npm run history:backfill -- --asset <ASSET> --from <startTs> --to <endTs> --dry-run
npm run history:backfill -- --asset <ASSET> --from <startTs> --to <endTs>
npm run history:gaps -- --asset <ASSET> --since 2026-10-28
```

Then re-run the `history-gap-detection` workflow with `workflow_dispatch`. A clean run (exit `0`) closes the alert.

If the dry run reports `0 row(s) would be replayed`, the source snapshot files do not cover the gap. Record it here as unrecoverable and stop.
