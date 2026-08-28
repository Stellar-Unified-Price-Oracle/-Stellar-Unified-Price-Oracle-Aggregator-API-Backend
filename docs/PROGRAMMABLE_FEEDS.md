# Programmable Price Feeds

Programmable feeds are described by a versioned DSL object containing sources, aggregation strategy, trigger conditions, guards, transforms, and optional conditionals. Deployment planning produces a Soroban feed contract name and gas estimate before deployment.

Supported aggregation strategies include median, arithmetic/geometric/harmonic mean, trimmed mean, VWAP, EMA, median-of-medians, and sandboxed WASM plugins.

Example feeds:

- Trimmed mean across Chainlink, Redstone, and Reflector.
- Chainlink-only feed with EMA smoothing.
- Multi-source feed with conditional fallback when a primary source is stale.

Marketplace listings track creator, usage count, rating, gas per submission, and the feed definition. Health evaluation tracks latency, uptime, market-reference deviation, and gas trends. Metering supports a configurable free tier and paid tier.
