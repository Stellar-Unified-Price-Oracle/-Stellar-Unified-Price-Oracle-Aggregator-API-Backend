# Resilience findings log

Record outcomes from weekly automated runs and quarterly game days in [resilience-findings.md](resilience-findings.md).

After each run:

1. Export the weekly report ConfigMap or run `./scripts/chaos/generate-report.sh`.
2. Compare observed metrics against SLO targets in resilience-findings.md.
3. File GitHub issues for gaps and link them in the findings table.
