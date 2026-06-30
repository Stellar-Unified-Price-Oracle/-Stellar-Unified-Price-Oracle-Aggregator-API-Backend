# Schema Changelog

Human-readable history of database schema changes. Each entry summarizes
**what** changed and **why**, so the rationale doesn't have to be reverse
engineered from the raw `up()`/`down()` migration code.

Every new migration file added to this directory must get a matching entry
here in the same PR.

## 1719378000000 — `init-price-oracle-schema`

**What:** Initial schema. Creates the `uuid-ossp` and `pg_trgm` extensions and
five tables:

| Table | Purpose |
| --- | --- |
| `assets` | Supported asset codes (e.g. `XLM`, `BTC`) and their decimal precision |
| `oracle_sources` | Registry of price-feed sources (e.g. `chainlink`, `redstone`) |
| `price_data` | Latest raw price per `(asset, source)` pair as reported by each source |
| `price_history` | Aggregated (median) price snapshots over time, with `source_count` recording how many sources contributed |
| `source_health` | Rolling health state per source: consecutive failures, last success/failure timestamps, last error |

Indexes were added on `assets.code`, `oracle_sources.code`, and the
`(asset_id, source_id)` / `timestamp` / `created_at` columns on `price_data`
and `price_history`, since those are the columns the aggregator and API
query on for lookups and time-range scans.

**Why:** Bootstraps storage for the core oracle pipeline: source ingestion
(`price_data`), aggregation output (`price_history`), and operational
visibility into source reliability (`source_health`) without joining against
external monitoring systems.

**Reversible:** Yes — `down()` drops all five tables in dependency order
(child tables before the `assets`/`oracle_sources` tables they reference).

---

## Template for new entries

```
## <timestamp> — `<migration-name>`

**What:** <tables/columns/indexes/constraints added, changed, or removed>

**Why:** <the driving requirement, bug, or product change>

**Reversible:** <yes/no — and any caveats about data loss on `down()`>
```
