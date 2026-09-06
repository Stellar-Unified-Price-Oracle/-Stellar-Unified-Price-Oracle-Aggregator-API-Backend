# Gas Subsidization Strategy and Treasury

Closes #456.

## Goal

Keep the oracle operational by guaranteeing that gas costs remain funded and by making the subsidy policy explicit before mainnet launch.

## Funding model

The project should use a treasury-first model for gas coverage:

- one treasury wallet holds the gas reserve for routine submissions
- a predictable monthly budget is derived from the measured warm-path gas cost
- subsidies are funded from protocol treasury or a dedicated gas pool, not from ad hoc transfers

## Cost inputs

The contract benchmark and cost model should remain the basis for the gas forecast. The monthly spend should be computed from:

- per-submission CPU and memory cost
- submission cadence
- number of watched assets
- current network resource fee rate

This mirrors the operating model already described in `docs/GAS_COST_MODEL.md` and keeps the economics grounded in observed measurements rather than static assumptions.

## Subsidization policy

- Auto-funded treasury coverage is the default for standard oracle operation.
- Consumers that require burst capacity or premium SLA tiers may opt into a fee pass-through model.
- The policy should be visible to operators and consumers so there is no ambiguity about who pays for failed or delayed submissions.

## Treasury alerts

An alert should fire at a configured threshold before the treasury falls below the minimum safe reserve. Recommended thresholds:

- warning: 30 days of forecasted spend remaining
- critical: 14 days of forecasted spend remaining
- emergency: reserve below 1x the next 7-day burn estimate

## Operational requirement

The treasury reserve should be reviewed on a fixed schedule and updated whenever the gas benchmark changes materially, such as a new feed shape, storage-layout change, or network fee adjustment.
