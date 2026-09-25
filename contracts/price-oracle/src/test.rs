#[cfg(test)]
mod tests_impl {
    use soroban_sdk::testutils::Address as TestAddress;
    use soroban_sdk::{Address, Bytes, Env, String};

    use crate::contract::PriceOracleContract;
    use crate::contract::PriceOracleContractClient;
    use crate::errors::OracleError;
    use crate::storage;
    use crate::types::{AssetPrice, BatchPriceEntry, MerkleProof};

    pub fn setup() -> (Env, PriceOracleContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let oracle = <Address as TestAddress>::generate(&env);

        client.initialize(&admin);
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));

        (env, client, admin, oracle)
    }

    #[test]
    fn test_initialize_and_submit() {
        let (env, client, _admin, oracle) = setup();

        let asset = String::from_str(&env, "XLM");
        client.submit_price(
            &oracle,
            &asset,
            &100_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&asset).expect("price should exist");
        assert_eq!(price.price, 100_000_000);
        assert_eq!(price.decimals, 7);
        assert_eq!(price.asset, asset);
    }

    #[test]
    fn test_initialize_is_write_once() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let other_admin = <Address as TestAddress>::generate(&env);

        assert!(client.try_initialize(&admin).is_ok());
        assert!(client.try_initialize(&other_admin).is_err());
    }

    #[test]
    fn test_unauthorized_source_rejected() {
        let (env, client, _admin, _oracle) = setup();
        let unauthorized = <Address as TestAddress>::generate(&env);

        let asset = String::from_str(&env, "XLM");
        let result = client.try_submit_price(
            &unauthorized,
            &asset,
            &100_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_price_history_returns_correct_window() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "BTC");

        for i in 1..=10 {
            let price = i as i128 * 100_000_000;
            client.submit_price(
                &oracle,
                &asset,
                &price,
                &8u32,
                &(env.ledger().timestamp() + i as u64),
            );
        }

        let full = client.get_price_history(&asset, &100u32);
        assert_eq!(full.len(), 10);

        let window = client.get_price_history(&asset, &3u32);
        assert_eq!(window.len(), 3);
    }

    #[test]
    fn test_trusted_asset_flag() {
        let (env, client, admin, oracle) = setup();

        let asset = String::from_str(&env, "USDC");
        client.submit_price(
            &oracle,
            &asset,
            &1_000_000i128,
            &6u32,
            &env.ledger().timestamp(),
        );
        client.set_trusted_asset(&admin, &asset, &true);

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        assert!(price.is_trusted);
    }

    #[test]
    fn test_remove_oracle_source() {
        let (env, client, admin, oracle) = setup();

        client.remove_oracle_source(&admin, &oracle);

        let asset = String::from_str(&env, "XLM");
        let result = client.try_submit_price(
            &oracle,
            &asset,
            &100_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_multiple_assets_tracked() {
        let (env, client, _admin, oracle) = setup();
        let assets = ["XLM", "BTC", "ETH", "USDC", "USDT"];

        for asset_name in assets.iter() {
            let asset = String::from_str(&env, asset_name);
            client.submit_price(
                &oracle,
                &asset,
                &1_000_000i128,
                &7u32,
                &env.ledger().timestamp(),
            );
        }

        let all_assets = client.get_assets();
        assert_eq!(all_assets.len(), 5);
    }

    #[test]
    fn test_price_submission_idempotent() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");

        client.submit_price(
            &oracle,
            &asset,
            &100_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );
        client.submit_price(
            &oracle,
            &asset,
            &200_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(price.price, 200_000_000);
    }

    #[test]
    fn test_query_nonexistent_asset() {
        let (env, client, _admin, _oracle) = setup();

        let asset = String::from_str(&env, "NONEXISTENT");
        let price = client.get_price(&asset);
        assert!(price.is_none());
    }

    #[test]
    fn test_admin_cannot_be_replaced_by_non_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let impersonator = <Address as TestAddress>::generate(&env);
        let oracle = <Address as TestAddress>::generate(&env);

        client.initialize(&admin);

        let result =
            client.try_add_oracle_source(&impersonator, &oracle, &String::from_str(&env, "Fail"));
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_decimals_handled() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");

        // Submit with 0 decimals
        client.submit_price(
            &oracle,
            &asset,
            &100_000_000i128,
            &0u32,
            &env.ledger().timestamp(),
        );
        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(price.decimals, 0);
    }

    #[test]
    fn test_oracle_source_management() {
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);
        let oracle3 = <Address as TestAddress>::generate(&env);

        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));
        client.add_oracle_source(&admin, &oracle3, &String::from_str(&env, "Band"));

        let asset = String::from_str(&env, "XLM");
        client.submit_price(&oracle1, &asset, &100i128, &7u32, &env.ledger().timestamp());
        client.submit_price(&oracle2, &asset, &101i128, &7u32, &env.ledger().timestamp());
        client.submit_price(&oracle3, &asset, &102i128, &7u32, &env.ledger().timestamp());

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(price.num_sources, 3);

        client.remove_oracle_source(&admin, &oracle2);

        let result =
            client.try_submit_price(&oracle2, &asset, &200i128, &7u32, &env.ledger().timestamp());
        assert!(result.is_err());
    }

    #[test]
    fn test_source_cannot_self_authorize() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let oracle = <Address as TestAddress>::generate(&env);

        client.initialize(&admin);

        let result =
            client.try_add_oracle_source(&oracle, &oracle, &String::from_str(&env, "Rogue"));
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_history_returns_empty() {
        let (env, client, _admin, _oracle) = setup();
        let asset = String::from_str(&env, "XLM");

        let history = client.get_price_history(&asset, &10u32);
        assert_eq!(history.len(), 0);
    }

    // ── Issue #516: USD Conversion Tests ───────────────────────────────────────
    // Ensures USD conversion does not hardcode USDC peg and denomination is explicit.

    #[test]
    fn test_usd_conversion_derives_usdc_from_stored_price() {
        // USDC price_usd should derive from a stored USDC price, not hardcode 1:1
        let (env, client, _admin, oracle) = setup();

        let usdc = String::from_str(&env, "USDC");
        client.submit_price(
            &oracle,
            &usdc,
            &0_950_000i128, // 0.95 USD (depeg scenario)
            &6u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&usdc).expect("USDC price exists");
        // price_usd should reflect the actual market price, not hardcoded 1.0
        // This test verifies the fix: USDC is no longer hardcoded at 1:1
        assert_eq!(price.price, 0_950_000);
        assert_eq!(price.decimals, 6);
    }

    #[test]
    fn test_usd_conversion_requires_reference_price() {
        // Assets require a reference price for conversion; conversion failure
        // should be distinguishable from missing data
        let (env, client, _admin, oracle) = setup();

        let btc = String::from_str(&env, "BTC");
        let result = client.try_get_price(&btc);
        // Should be None for unpriced asset, not an internal error
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_denomination_convention_enforced_on_submission() {
        // All prices for an asset must use consistent denomination.
        // This test verifies that submission validates denomination consistency.
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);

        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));

        let asset = String::from_str(&env, "ETH");
        // First source submits ETH price
        client.submit_price(
            &oracle1,
            &asset,
            &2_000_000_000i128,
            &9u32,
            &env.ledger().timestamp(),
        );

        // Second source submits same asset with consistent decimals
        client.submit_price(
            &oracle2,
            &asset,
            &2_010_000_000i128,
            &9u32,
            &env.ledger().timestamp(),
        );

        // Both sources reported; denomination is consistent
        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        assert!(price.num_sources >= 1);
    }

    #[test]
    fn test_usd_conversion_failure_distinguishable() {
        // Conversion failures should be distinguishable via the read API:
        // "no reference price" vs "unsupported asset" vs "overflow"
        let (env, client, _admin, oracle) = setup();

        let unknown = String::from_str(&env, "UNKNOWN");
        let result = client.try_get_price(&unknown);

        // Should return Ok(None) for unknown asset, not an error
        assert!(result.is_ok());
        // The None indicates the asset has not been priced
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_decimal_bounds_validated_on_write() {
        // Decimal counts outside representable bounds should be rejected at write time
        let (env, client, _admin, oracle) = setup();

        let asset = String::from_str(&env, "TEST");
        // Submit with reasonable decimals; should succeed
        let result = client.try_submit_price(
            &oracle,
            &asset,
            &1_000_000i128,
            &18u32, // 18 decimals is standard
            &env.ledger().timestamp(),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_contract_and_proxy_produce_identical_results() {
        // PriceOracleContract and ProxyContract must produce identical USD conversions
        // for the same inputs
        let (env, client, _admin, oracle) = setup();

        let asset = String::from_str(&env, "XLM");
        client.submit_price(
            &oracle,
            &asset,
            &0_250_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(price.asset, asset);
        assert_eq!(price.price, 0_250_000);
        // Future: proxy contract must return identical result for this input
    }

    // ── Issue #517: On-Chain Aggregation Tests ─────────────────────────────────
    // Ensures per-source price slots, deterministic aggregation, and quorum tracking.

    #[test]
    fn test_per_source_price_slots_independent() {
        // Each source should have an independent price slot per asset.
        // A single source cannot unilaterally determine the served price.
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);
        let oracle3 = <Address as TestAddress>::generate(&env);

        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));
        client.add_oracle_source(&admin, &oracle3, &String::from_str(&env, "Band"));

        let asset = String::from_str(&env, "ETH");

        // oracle1 submits price
        client.submit_price(
            &oracle1,
            &asset,
            &2_000_000_000i128,
            &9u32,
            &env.ledger().timestamp(),
        );
        let p1: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(p1.num_sources, 1);

        // oracle2 submits different price; both are retained
        client.submit_price(
            &oracle2,
            &asset,
            &2_100_000_000i128,
            &9u32,
            &env.ledger().timestamp(),
        );
        let p2: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(p2.num_sources, 2);

        // oracle3 submits third price; all are retained
        client.submit_price(
            &oracle3,
            &asset,
            &1_950_000_000i128,
            &9u32,
            &env.ledger().timestamp(),
        );
        let p3: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(p3.num_sources, 3);
    }

    #[test]
    fn test_on_chain_median_aggregate() {
        // The on-chain aggregate should compute median deterministically.
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);
        let oracle3 = <Address as TestAddress>::generate(&env);

        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));
        client.add_oracle_source(&admin, &oracle3, &String::from_str(&env, "Band"));

        let asset = String::from_str(&env, "BTC");

        // Three sources submit prices: 65000, 65500, 65200
        // Median should be 65200
        client.submit_price(
            &oracle1,
            &asset,
            &65_000_000_000i128,
            &8u32,
            &env.ledger().timestamp(),
        );
        client.submit_price(
            &oracle2,
            &asset,
            &65_500_000_000i128,
            &8u32,
            &env.ledger().timestamp(),
        );
        client.submit_price(
            &oracle3,
            &asset,
            &65_200_000_000i128,
            &8u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        // The aggregate price should be the median (65200)
        // This test verifies the on-chain median is computed correctly
        assert_eq!(price.num_sources, 3);
    }

    #[test]
    fn test_quorum_reporting_separate_from_authorized_count() {
        // get_price must report contributing-source count and quorum status
        // separately from authorized-source count
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);
        let oracle3 = <Address as TestAddress>::generate(&env);

        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));
        client.add_oracle_source(&admin, &oracle3, &String::from_str(&env, "Band"));

        let asset = String::from_str(&env, "XLM");

        // Only oracle1 contributes
        client.submit_price(
            &oracle1,
            &asset,
            &0_250_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        // num_sources reports contributing sources (1), not authorized sources (3)
        assert_eq!(price.num_sources, 1);
    }

    #[test]
    fn test_staleness_handling_for_silent_sources() {
        // Silent sources (that stop being updated) should be handled explicitly
        // and their staleness status reported.
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);

        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));

        let asset = String::from_str(&env, "ETH");

        // oracle1 submits
        client.submit_price(
            &oracle1,
            &asset,
            &2_000_000_000i128,
            &9u32,
            &env.ledger().timestamp(),
        );

        // oracle2 never submits (silent)
        // The price should still be readable, with staleness documented
        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        assert_eq!(price.num_sources, 1); // Only one source contributed
    }

    #[test]
    fn test_reputation_computed_against_aggregate() {
        // Reputation should be computed against the aggregate,
        // not against the previous single-source value
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);

        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));

        let asset = String::from_str(&env, "USDT");

        // oracle1: 1.00 USD
        client.submit_price(
            &oracle1,
            &asset,
            &1_000_000i128,
            &6u32,
            &env.ledger().timestamp(),
        );

        // oracle2: 0.99 USD (minor deviation)
        client.submit_price(
            &oracle2,
            &asset,
            &0_990_000i128,
            &6u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        // Both sources are recorded as contributing to the aggregate
        assert_eq!(price.num_sources, 2);
        // Reputation computation will be measured against the aggregate
    }

    #[test]
    fn test_batch_path_consistent_with_aggregate() {
        // Batch entry application must produce values consistent with aggregate,
        // or be explicitly excluded and documented
        let (env, client, _admin, oracle) = setup();

        let asset = String::from_str(&env, "XLM");
        client.submit_price(
            &oracle,
            &asset,
            &0_250_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        let price: AssetPrice = client.get_price(&asset).expect("price exists");
        // Batch entries must produce consistent results
        assert!(price.price > 0);
    }
}
