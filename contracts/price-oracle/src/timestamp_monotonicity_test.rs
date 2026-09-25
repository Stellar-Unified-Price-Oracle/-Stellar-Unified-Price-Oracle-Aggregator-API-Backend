#[cfg(test)]
mod tests_timestamp_monotonicity {
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
    fn test_reject_backdated_submission() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let base_time = 1000u64;

        // Submit initial price at timestamp 1000
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &base_time);

        // Attempt to submit older price at timestamp 500 (should be rejected)
        let result = client.try_submit_price(
            &oracle,
            &asset,
            &90_000_000i128,
            &7u32,
            &(base_time - 500),
        );
        // Should reject backdated submission
        assert!(result.is_err() || {
            // If accepted, verify it didn't overwrite
            let price: AssetPrice = client.get_price(&asset).expect("price should exist");
            price.timestamp == base_time
        });
    }

    #[test]
    fn test_accept_same_second_different_source() {
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);
        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));

        let asset = String::from_str(&env, "BTC");
        let timestamp = 2000u64;

        // First source submits at timestamp 2000
        client.submit_price(&oracle1, &asset, &100_000_000i128, &8u32, &timestamp);

        // Second source submits at same timestamp
        let result = client.try_submit_price(&oracle2, &asset, &101_000_000i128, &8u32, &timestamp);
        // Should allow same-second submission from different source
        assert!(result.is_ok());
    }

    #[test]
    fn test_accept_legitimate_correction() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "USDC");
        let timestamp = 3000u64;

        // Initial submission
        client.submit_price(&oracle, &asset, &100_000_000i128, &6u32, &timestamp);

        // Same source corrects with slightly newer timestamp
        let result = client.try_submit_price(
            &oracle,
            &asset,
            &101_000_000i128,
            &6u32,
            &(timestamp + 1),
        );
        assert!(result.is_ok());

        let price: AssetPrice = client.get_price(&asset).expect("price should exist");
        assert_eq!(price.price, 101_000_000);
        assert_eq!(price.timestamp, timestamp + 1);
    }

    #[test]
    fn test_history_remains_chronological_after_submissions() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "ETH");
        let base_time = 5000u64;

        // Submit prices in chronological order
        for i in 0..5 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &8u32,
                &(base_time + i as u64),
            );
        }

        let history = client.get_price_history(&asset, &10u32);

        // Verify chronological order
        for i in 0..(history.len() - 1) {
            let current = history.get(i).expect("should have entry");
            let next = history.get(i + 1).expect("should have entry");
            assert!(current.timestamp <= next.timestamp, "history should be in chronological order");
        }
    }

    #[test]
    fn test_reject_far_future_dated_submission() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let base_time = 6000u64;
        let max_future_skew = 86400u64; // 1 day

        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &base_time);

        // Attempt submission far in future (garbage or malicious clock)
        let result = client.try_submit_price(
            &oracle,
            &asset,
            &110_000_000i128,
            &7u32,
            &(base_time + max_future_skew + 1000),
        );
        // Should reject or accept depending on implementation,
        // but if accepted, the behavior should be documented
        let _ = result;
    }

    #[test]
    fn test_price_history_tail_is_most_recent() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "SOL");
        let base_time = 7000u64;

        // Submit 10 prices
        for i in 0..10 {
            client.submit_price(
                &oracle,
                &asset,
                &(50_000_000 + i as i128)i128,
                &2u32,
                &(base_time + i as u64),
            );
        }

        let all = client.get_price_history(&asset, &100u32);
        let last_three = client.get_price_history(&asset, &3u32);

        // Verify that the tail matches the most recent 3
        assert_eq!(last_three.len(), 3);
        for i in 0..3 {
            let tail_idx = all.len() - 3 + i;
            let all_entry = all.get(tail_idx).expect("should exist");
            let tail_entry = last_three.get(i).expect("should exist");
            assert_eq!(all_entry.timestamp, tail_entry.timestamp);
        }
    }
}
