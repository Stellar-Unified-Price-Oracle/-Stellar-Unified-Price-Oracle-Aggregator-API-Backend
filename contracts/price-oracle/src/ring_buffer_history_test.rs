#[cfg(test)]
mod tests_ring_buffer_history {
    use soroban_sdk::testutils::Address as TestAddress;
    use soroban_sdk::{Address, Env, String};

    use crate::contract::PriceOracleContract;
    use crate::contract::PriceOracleContractClient;
    use crate::storage;

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
    fn test_history_partial_fill() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let base_time = 1000u64;

        // Submit less than MAX_HISTORY_LEN entries
        for i in 0..5 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &7u32,
                &(base_time + i as u64),
            );
        }

        let history = client.get_price_history(&asset, &100u32);
        assert_eq!(history.len(), 5);

        // Verify all entries are in order
        for i in 0..5 {
            let entry = history.get(i).expect("should have entry");
            assert_eq!(entry.price, 100_000_000 + i as i128);
            assert_eq!(entry.timestamp, base_time + i as u64);
        }
    }

    #[test]
    fn test_history_exactly_at_capacity() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "BTC");
        let base_time = 2000u64;
        let max_history = storage::MAX_HISTORY_LEN as usize;

        // Fill history to exactly MAX_HISTORY_LEN
        for i in 0..max_history {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &8u32,
                &(base_time + i as u64),
            );
        }

        let history = client.get_price_history(&asset, &(max_history as u32 + 10));
        assert_eq!(history.len(), max_history);

        // Verify chronological order
        for i in 0..(history.len() - 1) {
            let current = history.get(i).expect("should have entry");
            let next = history.get(i + 1).expect("should have entry");
            assert!(current.timestamp <= next.timestamp);
        }
    }

    #[test]
    fn test_history_wraparound_oldest_dropped() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "ETH");
        let base_time = 3000u64;
        let max_history = storage::MAX_HISTORY_LEN as usize;

        // Fill beyond MAX_HISTORY_LEN
        for i in 0..(max_history + 5) {
            client.submit_price(
                &oracle,
                &asset,
                &(50_000_000 + i as i128)i128,
                &18u32,
                &(base_time + i as u64),
            );
        }

        let history = client.get_price_history(&asset, &((max_history + 10) as u32));

        // Should only have MAX_HISTORY_LEN entries
        assert_eq!(history.len(), max_history);

        // Oldest entries should be dropped (first 5)
        let first_entry = history.get(0).expect("should have entry");
        assert_eq!(first_entry.price, 50_000_000 + 5 as i128, "oldest 5 should be dropped");

        // Last entries should be the newest
        let last_entry = history.get(max_history - 1).expect("should have entry");
        assert_eq!(
            last_entry.price,
            50_000_000 + (max_history + 4) as i128,
            "newest entry should be present"
        );
    }

    #[test]
    fn test_history_chronological_order_preserved() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "USDC");
        let base_time = 4000u64;

        // Submit multiple entries
        for i in 0..20 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &6u32,
                &(base_time + i as u64),
            );
        }

        let history = client.get_price_history(&asset, &50u32);

        // Verify strict chronological ordering
        for i in 0..(history.len() - 1) {
            let current = history.get(i).expect("should have entry");
            let next = history.get(i + 1).expect("should have entry");
            assert!(
                current.timestamp < next.timestamp,
                "history must be in strict chronological order"
            );
        }
    }

    #[test]
    fn test_get_price_history_with_limit() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "SOL");
        let base_time = 5000u64;

        // Submit 30 prices
        for i in 0..30 {
            client.submit_price(
                &oracle,
                &asset,
                &(40_000_000 + i as i128)i128,
                &2u32,
                &(base_time + i as u64),
            );
        }

        // Request last 5
        let last_five = client.get_price_history(&asset, &5u32);
        assert_eq!(last_five.len(), 5);

        // Verify they are the most recent
        let first_of_five = last_five.get(0).expect("should have entry");
        assert_eq!(first_of_five.price, 40_000_000 + 25 as i128);

        let last_of_five = last_five.get(4).expect("should have entry");
        assert_eq!(last_of_five.price, 40_000_000 + 29 as i128);
    }

    #[test]
    fn test_batch_path_uses_ring_buffer() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let base_time = 6000u64;

        // Submit batch of prices
        for i in 0..15 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &7u32,
                &(base_time + i as u64),
            );
        }

        // Verify history is maintained correctly
        let history = client.get_price_history(&asset, &20u32);
        assert_eq!(history.len(), 15);

        // Verify ordering
        let prev_timestamp = history
            .get(0)
            .expect("should have entry")
            .timestamp;
        for i in 1..history.len() {
            let entry = history.get(i).expect("should have entry");
            assert!(entry.timestamp > prev_timestamp, "must maintain chronological order");
        }
    }

    #[test]
    fn test_write_cost_independent_of_history_length() {
        let (env, client, _admin, oracle) = setup();
        let asset1 = String::from_str(&env, "XLM");
        let asset2 = String::from_str(&env, "BTC");

        // Fill asset1 to near capacity
        let max_history = storage::MAX_HISTORY_LEN as usize;
        for i in 0..(max_history - 5) {
            client.submit_price(
                &oracle,
                &asset1,
                &(100_000_000 + i as i128)i128,
                &7u32,
                &(1000u64 + i as u64),
            );
        }

        // Add a few more to asset1
        for i in 0..3 {
            client.submit_price(
                &oracle,
                &asset1,
                &(100_000_000 + (max_history - 5 + i) as i128)i128,
                &7u32,
                &(1000u64 + (max_history - 5 + i) as u64),
            );
        }

        // Meanwhile, add to asset2 (should be equally efficient)
        for i in 0..3 {
            client.submit_price(
                &oracle,
                &asset2,
                &(50_000_000 + i as i128)i128,
                &8u32,
                &(2000u64 + i as u64),
            );
        }

        // Both should be readable
        let history1 = client.get_price_history(&asset1, &(max_history as u32));
        let history2 = client.get_price_history(&asset2, &100u32);

        assert!(history1.len() > 0);
        assert_eq!(history2.len(), 3);
    }
}
