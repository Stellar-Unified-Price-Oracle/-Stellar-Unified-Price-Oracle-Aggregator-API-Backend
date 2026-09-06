# Rate limit tiers and quota governance

The API applies per-key rate limits so quota enforcement is predictable and operationally visible to integrators.

## Tier behavior

- `free`: baseline quota for trial and low-volume traffic
- `pro`: higher request budget for production traffic
- `enterprise`: elevated allowance for partner and high-volume clients
- `admin`: operational access with explicit admin controls

Consumers receive quota usage through the standard rate limit headers:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`
- `Retry-After` on 429 responses

These headers are emitted alongside the API key validation flow so abuse detection and usage monitoring remain actionable.
