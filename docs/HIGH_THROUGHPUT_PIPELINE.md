# High-Throughput Pipeline

The aggregator now has reusable primitives for bounded fan-out/fan-in source fetching, incremental median maintenance, batch history buffering, and performance target verification.

Targets tracked by the benchmark contract:

- 100,000 sustained price updates per second.
- p99 end-to-end latency under 100 ms.
- all sources × 10 assets fetched in under 500 ms.
- batch writes at 100,000 events per second.
- event-loop blocking below 1 ms.

Production deployment should pair these primitives with HTTP/2 pooled transports, worker-thread execution for CPU-heavy stages, and Arrow IPC or Parquet storage for columnar history flushes.
