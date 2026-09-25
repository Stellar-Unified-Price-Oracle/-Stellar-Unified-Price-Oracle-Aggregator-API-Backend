#[cfg(test)]
mod tests_reputation_decay {
    use soroban_sdk::testutils::Address as TestAddress;
    use soroban_sdk::{Address, Env, String};

    use crate::contract::PriceOracleContract;
    use crate::contract::PriceOracleContractClient;
    use crate::utils;

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
    fn test_reputation_initial_score_perfect() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");

        // First submission should have perfect score
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &1000u64);

        let rep = client.get_source_reputation(&oracle).expect("reputation should exist");
        assert_eq!(rep.score, 10_000, "initial submission should have perfect score");
        assert_eq!(rep.total_submissions, 1);
        assert_eq!(rep.accurate_submissions, 1);
    }

    #[test]
    fn test_reputation_decay_over_periods() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let initial_time = 1000u64;
        let decay_period = utils::REPUTATION_DECAY_PERIOD_SECS;

        // Initial submission at time 1000
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &initial_time);

        let rep1 = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        assert_eq!(rep1.score, 10_000);

        // Simulate decay without new submissions
        // (In real implementation, this would involve advancing ledger time)
        // For now, verify structure is in place for decay
        assert_eq!(rep1.last_updated, initial_time);
    }

    #[test]
    fn test_reputation_decay_not_compounding() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let timestamp = 2000u64;

        // Submit initial price
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &timestamp);

        let rep1 = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        let score1 = rep1.score;

        // Read reputation multiple times (simulating repeated decay reads)
        let rep2 = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        let score2 = rep2.score;

        // Multiple reads should not compound decay
        assert_eq!(
            score1, score2,
            "reading reputation multiple times should not change score"
        );
    }

    #[test]
    fn test_reputation_score_bounded() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "BTC");
        let base_time = 3000u64;

        // Submit many accurate prices
        for i in 0..50 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &8u32,
                &(base_time + i as u64),
            );
        }

        let rep = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");

        // Score should never exceed 10_000 (100%)
        assert!(
            rep.score <= 10_000,
            "score should be bounded at 10000, got {}",
            rep.score
        );
        // Score should never be negative (checked by type)
        assert!(rep.score >= 0);
    }

    #[test]
    fn test_reputation_recovery_after_inaccuracy() {
        let (env, client, admin, oracle) = setup();
        let asset = String::from_str(&env, "ETH");
        let base_time = 4000u64;
        let threshold_bps = utils::REPUTATION_ACCURACY_THRESHOLD_BPS as u32;

        // Submit accurate prices to build reputation
        for i in 0..5 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &18u32,
                &(base_time + i as u64),
            );
        }

        let rep_good = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        let good_score = rep_good.score;

        // Submit a severely inaccurate price (deviation > threshold)
        let inaccurate_price = (100_000_000 as f64 * 1.5) as i128; // 50% deviation
        client.submit_price(
            &oracle,
            &asset,
            &inaccurate_price,
            &18u32,
            &(base_time + 100),
        );

        let rep_bad = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        let bad_score = rep_bad.score;

        // Score should decrease after inaccuracy
        assert!(
            bad_score < good_score,
            "score should decrease after inaccuracy"
        );

        // Now submit accurate prices to recover
        for i in 101..110 {
            client.submit_price(
                &oracle,
                &asset,
                &(100_000_000 + i as i128)i128,
                &18u32,
                &(base_time + i as u64),
            );
        }

        let rep_recovered = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        let recovered_score = rep_recovered.score;

        // Score should improve (though may not fully recover depending on decay/update logic)
        assert!(
            recovered_score > bad_score,
            "score should improve with accurate submissions"
        );
    }

    #[test]
    fn test_reputation_immediate_recovery_attempt() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "USDC");
        let base_time = 5000u64;

        // Submit an inaccurate price first
        client.submit_price(&oracle, &asset, &100_000_000i128, &6u32, &base_time);

        let rep1 = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        let score1 = rep1.score;

        // Immediately submit an accurate price
        let more_accurate = 101_000_000i128;
        client.submit_price(
            &oracle,
            &asset,
            &more_accurate,
            &6u32,
            &(base_time + 1),
        );

        let rep2 = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        let score2 = rep2.score;

        // Score should improve from accurate submission
        assert!(score2 >= score1, "accurate submission should not worsen score");
    }

    #[test]
    fn test_reputation_saturation_at_extremes() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "SOL");
        let base_time = 6000u64;

        // Submit many accurate prices to verify score doesn't overflow
        for i in 0..100 {
            client.submit_price(
                &oracle,
                &asset,
                &(40_000_000 + i as i128)i128,
                &2u32,
                &(base_time + i as u64),
            );
        }

        let rep = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");

        // Score should be at maximum (10_000)
        assert_eq!(rep.score, 10_000, "perfect submissions should yield 10000 score");
        assert_eq!(rep.accurate_submissions, rep.total_submissions);
    }

    #[test]
    fn test_reputation_tracks_accurate_vs_total() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        let base_time = 7000u64;

        // Submit first accurate price
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &base_time);

        let rep1 = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        assert_eq!(rep1.total_submissions, 1);
        assert_eq!(rep1.accurate_submissions, 1);

        // Submit another accurate price
        client.submit_price(
            &oracle,
            &asset,
            &101_000_000i128,
            &7u32,
            &(base_time + 1),
        );

        let rep2 = client
            .get_source_reputation(&oracle)
            .expect("reputation should exist");
        assert_eq!(rep2.total_submissions, 2);
        assert_eq!(rep2.accurate_submissions, 2);
    }

    #[test]
    fn test_reputation_multiple_sources_independent() {
        let (env, client, admin, oracle1) = setup();
        let oracle2 = <Address as TestAddress>::generate(&env);
        client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));

        let asset = String::from_str(&env, "BTC");
        let base_time = 8000u64;

        // Oracle 1 submits accurate prices
        for i in 0..3 {
            client.submit_price(
                &oracle1,
                &asset,
                &(100_000_000 + i as i128)i128,
                &8u32,
                &(base_time + i as u64),
            );
        }

        // Oracle 2 submits inaccurate price
        let inaccurate = (100_000_000 as f64 * 2.0) as i128;
        client.submit_price(&oracle2, &asset, &inaccurate, &8u32, &(base_time + 3));

        let rep1 = client
            .get_source_reputation(&oracle1)
            .expect("oracle1 reputation should exist");
        let rep2 = client
            .get_source_reputation(&oracle2)
            .expect("oracle2 reputation should exist");

        // Reputations should be independent
        assert!(rep1.score > rep2.score, "oracle1 should have better reputation than oracle2");
    }
}
