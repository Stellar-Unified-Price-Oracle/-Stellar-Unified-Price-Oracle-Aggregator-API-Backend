# Fee Schedule and Billing Model

This policy defines the commercial terms for consumer access to the Service.

## 1. Fee model

The current operating model separates two concerns:

- on-chain transaction costs, which are paid by infrastructure operators for price submissions and related contract calls;
- consumer access fees, which are applied at the API key or billing-account tier level.

The fee collection path is therefore: API key tier → usage accounting → monthly billing review → invoice or account credit.

## 2. Consumer fee schedule

| Tier | Access | Fee model |
| --- | --- | --- |
| Free | public sandbox and low-volume testing | no direct charge |
| Pro | production API access with higher rate limits | monthly invoice based on metered usage |
| Enterprise | dedicated capacity and custom support | negotiated contract rate |

For paid tiers, usage is counted per API key and reconciled against the configured tier limits. The billing record is generated from the same usage counters exposed in the developer portal and the admin usage endpoints.

## 3. Collection path

1. Each API key is assigned a tier and a rate limit.
2. Usage counters accumulate request volume, API errors, and last-used timestamps.
3. A monthly billing cycle converts metered usage into an invoice or account credit.
4. Invoices are reviewed in the portal and reconciled against the API key registry before payment is released.

## 4. Operational controls

The operator may:

- require a paid account for sustained production traffic;
- suspend or limit accesses that exceed the contracted tier;
- revise the fee schedule with advance notice in the developer portal or release notes.

This is a policy document; specific commercial terms are finalized in the customer contract or billing agreement that accompanies the API key account.
