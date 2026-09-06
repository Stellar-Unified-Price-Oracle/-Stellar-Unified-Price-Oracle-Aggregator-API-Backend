# Consumer Sandbox and Testnet Environment

Closes #455.

## Goal

Give consumers a safe and deterministic integration environment without exposing production secrets, billing data, or real market data.

## Environment model

The sandbox is explicitly isolated from production:

- separate namespace and credentials from the production deployment
- synthetic price fixtures instead of live production data
- read-only endpoints by default, with explicit reset hooks
- no access to production secrets or controller credentials

## Seeded data and reset flow

The API underlying sandbox implementation uses deterministic fixtures and a reset endpoint:

```bash
curl https://sandbox.example/api/v1/sandbox/info
curl -X POST https://sandbox.example/api/v1/sandbox/reset \
  -H 'x-sandbox-reset-token: <local-token>'
```

The reset endpoint clears the cache and repopulates the sandbox data set. Replay requests are limited to safe read-only paths, which prevents accidental mutation or unsafe replay against live endpoints.

## Security guardrails

- `SANDBOX_ENABLED` toggles the sandbox environment on or off.
- `SANDBOX_RESET_TOKEN` restricts reset operations to trusted operators.
- The sandbox should never share the same API keys, wallet secrets, or storage as production.
- Endpoints should report synthetic data clearly so downstream clients do not mistake sandbox responses for production prices.

## Automation

The sandbox should be reset as part of automated integration tests and staging exercises. Operators can use the existing `/api/v1/sandbox/reset` route from CI to restore a known dataset before running compatibility checks.
