#[cfg(test)]
mod staking_tests {
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
    use soroban_sdk::{Address, Env, String};

    use crate::contract::{PriceOracleContract, PriceOracleContractClient};
    use crate::errors::OracleError;
    use crate::storage;

    struct Ctx {
        env: Env,
        contract_id: Address,
        client: PriceOracleContractClient<'static>,
        admin: Address,
        treasury: Address,
        token: Address,
        token_client: TokenClient<'static>,
        asset_admin: StellarAssetClient<'static>,
        source: Address,
    }

    fn setup() -> Ctx {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let source = Address::generate(&env);

        client.initialize(&admin);
        client.add_oracle_source(&admin, &source, &String::from_str(&env, "Chainlink"));

        let stellar_asset = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token = stellar_asset.address();

        Ctx {
            token_client: TokenClient::new(&env, &token),
            asset_admin: StellarAssetClient::new(&env, &token),
            env,
            contract_id,
            client,
            admin,
            treasury,
            token,
            source,
        }
    }

    /// Assert the call failed with a specific `OracleError`.
    ///
    /// The generated client decodes a contract failure into the typed error, so
    /// a known error arrives as `Err(Ok(OracleError::..))`; anything else (a
    /// trap, an abort, or an unrecognised code) lands in `Err(Err(..))`.
    fn expect_error<T: core::fmt::Debug>(
        res: Result<
            Result<T, soroban_sdk::ConversionError>,
            Result<OracleError, soroban_sdk::InvokeError>,
        >,
        expected: OracleError,
    ) {
        match res {
            Ok(_) => panic!("expected {expected:?} but the call succeeded"),
            Err(Ok(actual)) => assert_eq!(actual, expected, "unexpected contract error"),
            Err(Err(other)) => {
                panic!("expected {expected:?} but got a non-contract failure: {other:?}")
            }
        }
    }

    // ── Staking ───────────────────────────────────────────────────────────────

    #[test]
    fn test_stake_moves_tokens_into_the_contract() {
        let ctx = setup();
        ctx.asset_admin.mint(&ctx.source, &1_000i128);

        ctx.client.stake(&ctx.source, &400i128, &ctx.token);

        assert_eq!(ctx.token_client.balance(&ctx.source), 600);
        assert_eq!(ctx.token_client.balance(&ctx.contract_id), 400);
        assert_eq!(ctx.client.get_stake_balance(&ctx.source), 400);
    }

    #[test]
    fn test_stake_rejects_non_positive_amount() {
        let ctx = setup();
        ctx.asset_admin.mint(&ctx.source, &1_000i128);

        expect_error(
            ctx.client.try_stake(&ctx.source, &0i128, &ctx.token),
            OracleError::InvalidStakeAmount,
        );
        expect_error(
            ctx.client.try_stake(&ctx.source, &-5i128, &ctx.token),
            OracleError::InvalidStakeAmount,
        );
        assert_eq!(ctx.token_client.balance(&ctx.source), 1_000);
    }

    #[test]
    fn test_stake_rejects_top_up_in_a_different_token() {
        let ctx = setup();
        let other_asset = ctx.env.register_stellar_asset_contract_v2(Address::generate(&ctx.env));
        let other_token = other_asset.address();

        ctx.asset_admin.mint(&ctx.source, &1_000i128);
        ctx.client.stake(&ctx.source, &100i128, &ctx.token);

        expect_error(
            ctx.client.try_stake(&ctx.source, &100i128, &other_token),
            OracleError::StakeTokenMismatch,
        );
        assert_eq!(ctx.client.get_stake_balance(&ctx.source), 100);
    }

    // ── Slashing ──────────────────────────────────────────────────────────────

    #[test]
    fn test_slash_moves_tokens_to_the_treasury() {
        let ctx = setup();
        ctx.asset_admin.mint(&ctx.source, &1_000i128);
        ctx.client.stake(&ctx.source, &1_000i128, &ctx.token);
        ctx.client.set_stake_treasury(&ctx.admin, &ctx.treasury);

        ctx.client
            .slash(&ctx.source, &250i128, &String::from_str(&ctx.env, "stale feed"));

        // This is the regression: before the fix `slash` only decremented a
        // counter, so the treasury balance stayed at zero.
        assert_eq!(ctx.token_client.balance(&ctx.treasury), 250);
        assert_eq!(ctx.token_client.balance(&ctx.contract_id), 750);
        assert_eq!(ctx.client.get_stake_balance(&ctx.source), 750);
    }

    #[test]
    fn test_slash_caps_at_the_recorded_stake() {
        let ctx = setup();
        ctx.asset_admin.mint(&ctx.source, &1_000i128);
        ctx.client.stake(&ctx.source, &300i128, &ctx.token);
        ctx.client.set_stake_treasury(&ctx.admin, &ctx.treasury);

        ctx.client
            .slash(&ctx.source, &10_000i128, &String::from_str(&ctx.env, "overslash"));

        assert_eq!(ctx.token_client.balance(&ctx.treasury), 300);
        assert_eq!(ctx.token_client.balance(&ctx.contract_id), 0);
        assert_eq!(ctx.client.get_stake_balance(&ctx.source), 0);
    }

    #[test]
    fn test_slash_requires_a_configured_treasury() {
        let ctx = setup();
        ctx.asset_admin.mint(&ctx.source, &1_000i128);
        ctx.client.stake(&ctx.source, &1_000i128, &ctx.token);

        expect_error(
            ctx.client
                .try_slash(&ctx.source, &10i128, &String::from_str(&ctx.env, "x")),
            OracleError::TreasuryNotConfigured,
        );
        assert_eq!(ctx.client.get_stake_balance(&ctx.source), 1_000);
    }

    #[test]
    fn test_slash_without_a_recorded_token_is_rejected() {
        let ctx = setup();
        // State written before the staked token was tracked: a counter with no
        // record of which asset backs it.  Slashing it would move nothing, so
        // the call has to fail loudly instead.
        ctx.env.as_contract(&ctx.contract_id, || {
            storage::set_stake(&ctx.env, &ctx.source, &100i128);
        });
        ctx.client.set_stake_treasury(&ctx.admin, &ctx.treasury);

        expect_error(
            ctx.client
                .try_slash(&ctx.source, &10i128, &String::from_str(&ctx.env, "x")),
            OracleError::StakeTokenNotRecorded,
        );
    }

    #[test]
    fn test_slash_rejects_non_positive_amount() {
        let ctx = setup();
        ctx.asset_admin.mint(&ctx.source, &1_000i128);
        ctx.client.stake(&ctx.source, &1_000i128, &ctx.token);
        ctx.client.set_stake_treasury(&ctx.admin, &ctx.treasury);

        expect_error(
            ctx.client
                .try_slash(&ctx.source, &0i128, &String::from_str(&ctx.env, "x")),
            OracleError::InvalidSlashAmount,
        );
    }

    #[test]
    fn test_slash_with_no_stake_is_rejected() {
        let ctx = setup();
        ctx.client.set_stake_treasury(&ctx.admin, &ctx.treasury);

        expect_error(
            ctx.client
                .try_slash(&ctx.source, &10i128, &String::from_str(&ctx.env, "x")),
            OracleError::NoStakeToSlash,
        );
    }

    // ── Invariant ─────────────────────────────────────────────────────────────

    /// The contract's real token balance and the sum of tracked stakes must
    /// never disagree.  This is the property the original `slash` broke.
    #[test]
    fn test_contract_balance_reconciles_with_tracked_stakes() {
        let ctx = setup();
        let second_source = Address::generate(&ctx.env);
        ctx.client.add_oracle_source(
            &ctx.admin,
            &second_source,
            &String::from_str(&ctx.env, "Band"),
        );

        ctx.asset_admin.mint(&ctx.source, &1_000i128);
        ctx.asset_admin.mint(&second_source, &500i128);
        ctx.client.stake(&ctx.source, &1_000i128, &ctx.token);
        ctx.client.stake(&second_source, &500i128, &ctx.token);
        ctx.client.set_stake_treasury(&ctx.admin, &ctx.treasury);

        ctx.client
            .slash(&ctx.source, &200i128, &String::from_str(&ctx.env, "bad data"));
        ctx.client
            .slash(&second_source, &600i128, &String::from_str(&ctx.env, "overslash"));

        let tracked = ctx.client.get_stake_balance(&ctx.source)
            + ctx.client.get_stake_balance(&second_source);
        assert_eq!(ctx.token_client.balance(&ctx.contract_id), tracked);
        assert_eq!(tracked, 800);
        assert_eq!(ctx.token_client.balance(&ctx.treasury), 700);
    }
}
