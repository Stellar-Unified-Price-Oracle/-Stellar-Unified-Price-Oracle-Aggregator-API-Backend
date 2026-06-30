# Runbook: Price Anomaly Detected

**Linked alerts:** `PriceDeviation`, `stellar_oracle_anomalies_detected_total > 0`
**Severity:** P2 (single anomaly) / P1 (sustained anomalies across assets)

## Symptoms

- `PriceDeviation` Prometheus alert fires
- `stellar_oracle_anomaly_score` gauge is elevated (>1.0)
- Logs contain `[AnomalyDetector] <asset>: anomaly detected`
- Aggregated price response includes `anomaly` field with `isAnomaly: true`

## Diagnosis

```bash
# 1. Check anomaly metrics in Prometheus
# stellar_oracle_anomalies_detected_total{asset="XLM"}

# 2. Check recent price history for the affected asset
curl "https://<api-host>/api/v1/history/XLM?limit=20" | jq '.data.prices[] | {price, timestamp, source}'

# 3. Identify which detection method triggered
# Check logs for method: zscore | moving_average | volatility
kubectl logs -l app=stellar-aggregator | grep "AnomalyDetector"

# 4. Cross-check prices across sources
curl "https://<api-host>/api/v1/prices/XLM" | jq '.data'
```

## Assessment

### Is this a real anomaly?

| Signal | Likely cause |
|--------|-------------|
| All sources agree on the new price | Real market move — not an anomaly |
| Only one source shows the spike | Source data issue (stale data, miscalculation) |
| Spike then immediate reversion | Flash crash or flash pump — real but transient |
| Anomaly persists >5 min across sources | Potential oracle manipulation or network partition |

### False positive rate

Monitor `stellar_oracle_anomalies_detected_total` vs confirmed incidents. If false positives are high, tune sensitivity:

1. Open `services/aggregator/src/anomaly-detector.ts`
2. Call `anomalyDetector.setConfig(asset, { zScoreThreshold: 4.0 })` to reduce sensitivity
3. Or increase `movingAverageDeviationPercent`

## Mitigation

- **Real market move**: No action — the oracle correctly reflects market prices.
- **Bad source data**: The circuit breaker will eventually remove the outlier source. If urgent, the source can be excluded from `WATCHED_SOURCES` env var temporarily.
- **Sustained cross-source anomaly**: Escalate to P1. Investigate Soroban contract events for any signs of manipulation.

## Related

- [oracle-source-down.md](oracle-source-down.md)
- [post-mortem-template.md](post-mortem-template.md)
