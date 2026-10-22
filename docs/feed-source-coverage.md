# Production feed source coverage

Owner: Feed catalog workstream (API team).

Generated from [feed-source-coverage.json](../scripts/feed-source-coverage.json) by `npm run coverage:feeds`. Manifest last reviewed: 2026-10-21.

| Feed | Asset | Default provider asset support | Production quorum | Active production regions | Runtime status | Known limitations |
|---|---|---|---|---|---|---|
| xlm-usd | XLM/USD | chainlink (supports asset by default)<br>redstone (supports asset by default)<br>band (supports asset by default)<br>reflector (supports asset by default) | not configured | ap-southeast-1, eu-west-1, us-east-1 (deployed overlays) | not-measured | The production feed catalog has no checked-in quorum policy; catalog policies are process-local and are not persisted across API restarts.<br>Live provider availability is not verified by this matrix. |
| usdc-usd | USDC/USD | chainlink (supports asset by default)<br>redstone (supports asset by default)<br>band (supports asset by default)<br>reflector (supports asset by default) | not configured | ap-southeast-1, eu-west-1, us-east-1 (deployed overlays) | not-measured | The production feed catalog has no checked-in quorum policy; catalog policies are process-local and are not persisted across API restarts.<br>Live provider availability is not verified by this matrix. |
| btc-usd | BTC/USD | chainlink (supports asset by default)<br>redstone (supports asset by default)<br>band (supports asset by default)<br>reflector (supports asset by default) | not configured | ap-southeast-1, eu-west-1, us-east-1 (deployed overlays) | not-measured | The production feed catalog has no checked-in quorum policy; catalog policies are process-local and are not persisted across API restarts.<br>Live provider availability is not verified by this matrix. |
| eth-usd | ETH/USD | chainlink (supports asset by default)<br>redstone (supports asset by default)<br>band (supports asset by default)<br>reflector (supports asset by default) | not configured | ap-southeast-1, eu-west-1, us-east-1 (deployed overlays) | not-measured | The production feed catalog has no checked-in quorum policy; catalog policies are process-local and are not persisted across API restarts.<br>Live provider availability is not verified by this matrix. |
| usdt-usd | USDT/USD | chainlink (supports asset by default)<br>redstone (supports asset by default)<br>band (supports asset by default)<br>reflector (supports asset by default) | not configured | ap-southeast-1, eu-west-1, us-east-1 (deployed overlays) | not-measured | The production feed catalog has no checked-in quorum policy; catalog policies are process-local and are not persisted across API restarts.<br>Live provider availability is not verified by this matrix. |

## Evidence and scope

The source column is validated against the aggregator's default asset capability profiles. Those profiles are not per-feed production eligibility policies. The repository has no persistent production feed policy store: API catalog policies are process-local, and no checked-in policy configures production quorum. Therefore quorum is shown as not configured unless a durable production policy is added. Regions are derived from production Kubernetes overlays; they identify deployed regions, not proof that every provider runs in each region. Runtime status is **not-measured**; this matrix does not claim live provider health or successful quotes. This repository manifest describes configured provider and region coverage; it does not prove live provider availability or successful quotes.

For a measured status, record the probe timestamp and evidence reference in the manifest. Evidence must report per-feed/per-region eligible providers observed during the same probe window.

## Review procedure and completion evidence

Run `npm run coverage:feeds` to regenerate, `npm run coverage:feeds:check` to verify the checked-in output, and `npm run coverage:feeds:test` to exercise normal, boundary, and invalid-manifest cases. Completion passes when these commands exit 0, all five default watched assets appear exactly once, each listed provider supports its asset in the source capability registry, and the region set matches production overlay directories. Negative cases cover missing feeds, unknown sources, quorum boundaries, and incomplete runtime evidence.

Review this artifact whenever provider capability defaults, production overlays, feed eligibility, quorum, or runtime probe evidence changes.

## Compatibility and operations

This is a generated documentation artifact; it does not change API responses, price calculation, provider polling, or on-chain publication. Monitor provider assignment rejection logs and existing quorum metrics when interpreting declared coverage. A provider configured to support an asset can still be unavailable at runtime.

## Rollout and rollback

Rollout by regenerating and committing this matrix with its manifest after review. If generated output is incorrect, restore the prior manifest and regenerate; no service deployment or data migration is involved. If live behavior is affected by a source-policy change, revert the policy change through the feed catalog and use its existing versioned change log.
