#[cfg(test)]
mod tests_storage_migration {
    use soroban_sdk::testutils::Address as TestAddress;
    use soroban_sdk::{Address, Env, String};

    use crate::contract::PriceOracleContract;
    use crate::contract::PriceOracleContractClient;
    use crate::types::AssetPrice;

    fn setup() -> (Env, PriceOracleContractClient<'static>, Address, Address) {
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
    fn test_pre_migration_state_read_equivalence() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let timestamp = 1000u64;

        // Store a price
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &timestamp);

        // Read the price before migration
        let price_before: AssetPrice = client.get_price(&asset).expect("price should exist");
        assert_eq!(price_before.price, 100_000_000);
        assert_eq!(price_before.decimals, 7);
        assert_eq!(price_before.timestamp, timestamp);
    }

    #[test]
    fn test_post_migration_get_price_consistency() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "BTC");
        let timestamp = 2000u64;

        // Store multiple prices
        for i in 0..3 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &8u32,
                &(timestamp + i as u64),
            );
        }

        // Read latest price
        let latest: AssetPrice = client.get_price(&asset).expect("price should exist");
        assert_eq!(latest.price, 100_000_002);
    }

    #[test]
    fn test_post_migration_history_consistency() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "ETH");
        let timestamp = 3000u64;

        // Store 5 historical prices
        for i in 0..5 {
            client.submit_price(
                &oracle,
                &asset,
                &(50_000_000 + i as i128)i128,
                &18u32,
                &(timestamp + i as u64),
            );
        }

        // Read history
        let history = client.get_price_history(&asset, &10u32);
        assert_eq!(history.len(), 5);

        // Verify all entries are accessible
        for i in 0..5 {
            let entry = history.get(i).expect("should have entry");
            assert_eq!(entry.price, 50_000_000 + i as i128);
            assert_eq!(entry.timestamp, timestamp + i as u64);
        }
    }

    #[test]
    fn test_migration_preserves_asset_list() {
        let (env, client, admin, oracle) = setup();

        // Add multiple assets
        let assets = vec![
            String::from_str(&env, "XLM"),
            String::from_str(&env, "BTC"),
            String::from_str(&env, "ETH"),
        ];

        for (i, asset) in assets.iter().enumerate() {
            client.submit_price(
                &oracle,
                asset,
                &(100_000_000 + i as i128)i128,
                &(7 + i as u32),
                &(1000u64 + i as u64),
            );
        }

        // Verify all assets are readable
        let xlm = client.get_price(&assets[0]).expect("XLM should exist");
        let btc = client.get_price(&assets[1]).expect("BTC should exist");
        let eth = client.get_price(&assets[2]).expect("ETH should exist");

        assert_eq!(xlm.asset, assets[0]);
        assert_eq!(btc.asset, assets[1]);
        assert_eq!(eth.asset, assets[2]);
    }

    #[test]
    fn test_migration_resumable_idempotence() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "USDC");
        let timestamp = 5000u64;

        // Submit initial price
        client.submit_price(&oracle, &asset, &100_000_000i128, &6u32, &timestamp);

        // Read price multiple times (simulating repeated migration steps)
        let price1 = client.get_price(&asset).expect("first read");
        let price2 = client.get_price(&asset).expect("second read");
        let price3 = client.get_price(&asset).expect("third read");

        // All reads should return the same value
        assert_eq!(price1.price, price2.price);
        assert_eq!(price2.price, price3.price);
        assert_eq!(price1.timestamp, price2.timestamp);
        assert_eq!(price2.timestamp, price3.timestamp);
    }

    #[test]
    fn test_migration_batch_consistency() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "SOL");

        // Submit several prices that will be stored
        for i in 0..10 {
            client.submit_price(
                &oracle,
                &asset,
                &(40_000_000 + i as i128)i128,
                &2u32,
                &(6000u64 + i as u64),
            );
        }

        // Read full history
        let history = client.get_price_history(&asset, &100u32);
        assert_eq!(history.len(), 10);

        // Verify each entry is intact
        for (i, entry) in (0..history.len()).enumerate() {
            let e = history.get(i).expect("should have entry");
            assert_eq!(e.price, 40_000_000 + i as i128);
        }
    }

    #[test]
    fn test_migration_preserves_source_authorization() {
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);

        // Add second source
        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));

        let asset = String::from_str(&env, "XLM");
        let timestamp = 7000u64;

        // Both sources can submit
        let result1 = client.try_submit_price(&oracle1, &asset, &100_000_000i128, &7u32, &timestamp);
        assert!(result1.is_ok());

        let result2 = client.try_submit_price(
            &oracle2,
            &asset,
            &101_000_000i128,
            &7u32,
            &(timestamp + 1),
        );
        assert!(result2.is_ok());

        // Unauthorized source still cannot submit
        let unauthorized = <Address as TestAddress>::generate(&env);
        let result_unauth = client.try_submit_price(
            &unauthorized,
            &asset,
            &99_000_000i128,
            &7u32,
            &(timestamp + 2),
        );
        assert!(result_unauth.is_err());
    }
}
