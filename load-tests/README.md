# Load and capacity testing

The k6 scenarios under `load-tests/k6/` exercise the production-shaped API topology before launch.

## Peak traffic run

```bash
BASE_URL=http://api.example.com PEAK_RPS=125 DURATION=10m k6 run load-tests/k6/production-peak.js
```

Record the p99 latency and error rate against the SLOs in the deployment checklist. If a threshold is breached, document the issue and treat it as a blocker before production rollout.

## Existing scenarios

- `endpoint-scenarios.js` - general endpoint validation
- `api-benchmark.js` - baseline API benchmark
- `websocket-benchmark.js` - WebSocket saturation check
- `production-peak.js` - projected peak-load scenario for production-shaped traffic
