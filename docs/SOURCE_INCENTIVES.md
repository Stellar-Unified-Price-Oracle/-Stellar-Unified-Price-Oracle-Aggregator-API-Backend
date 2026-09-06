# Oracle Source Incentives Production Readiness

Closes #457.

## Goal

Make staking, rewards, and slashing operational so source operators remain accountable for feed quality and availability.

## Production model

The source incentive lifecycle should include three phases:

1. `stake`: a source operator locks collateral before participating in the feed set
2. `reward`: honest submissions earn a share of the protocol reward pool based on uptime and data quality
3. `slash`: a source is penalized for stale, invalid, or malicious submissions beyond the configured tolerance

## Recommended operating parameters

The exact values should be tuned against live on-chain testnet behavior, but the design should start from a simple, auditable model:

- minimum collateral required to be eligible for source registration
- per-asset reward schedule based on successful submissions and freshness
- slashing for stale feeds, inconsistent data, or repeated liveness failures
- cooldown period before a slashed operator is eligible to rejoin

## Testnet lifecycle validation

Before mainnet launch, the workflow should be exercised end-to-end on testnet:

- register a new source
- submit valid data for several cycles
- observe reward accrual
- trigger a stale or invalid submission to confirm the slash path
- verify the source is removed or disabled according to policy

## Documentation requirement

Operators need clear guidance on:

- initial staking and reward formulas
- liveness and validity thresholds
- slash triggers and appeal windows
- impact of downtime on eligibility and rewards

Once the above lifecycle is proven on testnet, the same thresholds can be promoted to mainnet with the documented governance signoff.
