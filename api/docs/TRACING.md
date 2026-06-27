# Distributed Request Tracing

The API implements OpenTelemetry-based distributed tracing to track requests across services and identify performance bottlenecks.

## Overview

Each request receives:
- **Request ID** (`x-request-id`): Unique identifier for the specific request
- **Trace ID** (`x-trace-id`): Unique identifier for the entire transaction across all services
- **Span ID** (`x-span-id`): Unique identifier for the current operation

These headers are:
- Accepted from incoming requests (for cross-service propagation)
- Automatically generated if not provided
- Included in all HTTP responses
- Logged with every request

## Configuration

Set these environment variables to enable tracing:

```bash
# Enable distributed tracing
TRACING_ENABLED=true

# Jaeger collector endpoint
JAEGER_ENDPOINT=http://localhost:14268/api/traces

# Sampling rate (0-1, where 1 = 100% sampling)
TRACING_SAMPLING_RATE=1

# Service name in Jaeger
TRACING_SERVICE_NAME=stellar-oracle-api
```

## Local Development with Jaeger

### 1. Start Jaeger locally using Docker:

```bash
docker run -d \
  --name jaeger \
  -p 6831:6831/udp \
  -p 16686:16686 \
  -p 14268:14268 \
  jaegertracing/all-in-one:latest
```

### 2. Enable tracing in .env:

```bash
TRACING_ENABLED=true
JAEGER_ENDPOINT=http://localhost:14268/api/traces
```

### 3. Start the API:

```bash
npm run dev
```

### 4. View traces in Jaeger UI:

Open http://localhost:16686 in your browser.

## Cross-Service Context Propagation

When calling other services (aggregator, contracts), propagate trace context:

```typescript
import axios from 'axios';
import { trace } from '@opentelemetry/api';

async function callAggregator(req) {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;

  const response = await axios.get('http://localhost:4000/prices', {
    headers: {
      'x-trace-id': traceId,
      'x-request-id': req.requestId,
    },
  });

  return response.data;
}
```

## Log Correlation

All logs include trace context automatically:

```json
{
  "timestamp": "2026-06-26T12:34:56.789Z",
  "level": "info",
  "message": "GET /api/v1/prices",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "service": "stellar-price-api"
}
```

## Performance Impact

- **Sampling**: Use `TRACING_SAMPLING_RATE` to limit overhead in production
- **Recommended rates**:
  - Development: `1` (100%)
  - Staging: `0.1` (10%)
  - Production: `0.01` (1%)

## Jaeger Query Examples

### Find slow requests

```
service.name="stellar-oracle-api" AND duration>1000ms
```

### Find errors

```
service.name="stellar-oracle-api" AND error=true
```

### Find specific request

```
service.name="stellar-oracle-api" AND tags.request.id="550e8400-e29b-41d4-a716-446655440000"
```

## Disabling Tracing

Tracing is disabled by default. Set `TRACING_ENABLED=false` or omit it to disable.

## References

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
