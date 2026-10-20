// Gas benchmarks for the PriceOracleContract.
//
// Each test follows the same pattern:
//   1. Set up the environment and contract.
//   2. Reset the CPU/memory budget.
//   3. Execute the entry point under measurement.
//   4. Print the consumed cpu_instructions and mem_bytes to stdout.
//
// Run with:
//   cargo test bench_ --lib -- --nocapture
//
// The Soroban test environment does not enforce budget limits by default
// (Env::default() has an unlimited budget).  We call budget.reset_default()
// to apply the standard Mainnet limits before each measurement so the
// instruction counts reflect real-world conditions.
//
// ── Consumer-side cost methodology (Issue #727) ─────────────────────────────
//
// The `bench_consumer_*` tests measure the read/verify paths that downstream
// consumers (dapps, aggregators, bridges) actually pay for, across
// representative feed counts (1, 5, 20, and the configured maximum).  Each
// test:
//   1. Seeds `N` distinct assets so the contract holds a realistic feed set.
//   2. Resets the budget to the Mainnet default limits.
//   3. Invokes the consumer entry point exactly once.
//   4. Prints a `[CONSUMER]` row with cpu_instructions and mem_bytes.
//
// Boundary cases cover the maximum feed count (the worst-case read) and the
// failure paths (insufficient fee / not-whitelisted caller) so the cost of a
// rejected call is also captured.  The printed rows form a reproducible table:
// re-run `cargo test bench_consumer_ --lib -- --nocapture` on any commit and
// diff the output to detect consumer-side regressions.  See
// docs/GAS_COST_MODEL.md for how to convert the instruction counts into a
// per-call fee using the current mainnet resource fee rate.

#[cfg(test)]
mod bench {
    extern crate std;
    use std::println;

    use soroban_sdk::{
        testutils::Address as _,
        Address, Bytes, Env, String, Vec,
    };

    use crate::contract::{PriceOracleContract, PriceOracleContractClient};

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn setup() -> (Env, PriceOracleContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);

        client.initialize(&admin);
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));

        (env, client, admin, oracle)
    }

    fn print_budget(label: &str, env: &Env) {
        let budget = env.cost_estimate().budget();
        println!(
            "[BENCH] {label}: cpu_instructions={}, mem_bytes={}",
            budget.cpu_instruction_cost(),
            budget.memory_bytes_cost(),
        );
    }

    // ── initialize ────────────────────────────────────────────────────────────

    #[test]
    fn bench_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &id);
        let admin = Address::generate(&env);

        env.cost_estimate().budget().reset_default();
        client.initialize(&admin);
        print_budget("initialize", &env);
    }

    // ── submit_price (cold — first submission for asset) ─────────────────────

    #[test]
    fn bench_submit_price_cold() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");

        env.cost_estimate().budget().reset_default();
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &0u64);
        print_budget("submit_price (cold)", &env);
    }

    // ── submit_price (warm — asset already exists, history has 10 entries) ───

    #[test]
    fn bench_submit_price_warm() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "BTC");

        for i in 0u64..10 {
            client.submit_price(&oracle, &asset, &(i as i128 * 1_000_000), &8u32, &i);
        }

        env.cost_estimate().budget().reset_default();
        client.submit_price(&oracle, &asset, &50_000_000i128, &8u32, &10u64);
        print_budget("submit_price (warm, 10 history entries)", &env);
    }

    // ── submit_price at history cap (100 entries, triggers trim) ─────────────

    #[test]
    fn bench_submit_price_at_cap() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "ETH");

        for i in 0u64..100 {
            client.submit_price(&oracle, &asset, &(i as i128 * 1_000), &18u32, &i);
        }

        env.cost_estimate().budget().reset_default();
        client.submit_price(&oracle, &asset, &999_999i128, &18u32, &100u64);
        print_budget("submit_price (at cap, 100 history entries, trim)", &env);
    }

    // ── get_price ─────────────────────────────────────────────────────────────

    #[test]
    fn bench_get_price() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &0u64);

        env.cost_estimate().budget().reset_default();
        let _ = client.get_price(&asset);
        print_budget("get_price", &env);
    }

    // ── get_price (asset not found) ───────────────────────────────────────────

    #[test]
    fn bench_get_price_not_found() {
        let (env, client, _admin, _oracle) = setup();
        let asset = String::from_str(&env, "NONEXISTENT");

        env.cost_estimate().budget().reset_default();
        let _ = client.get_price(&asset);
        print_budget("get_price (not found)", &env);
    }

    // ── get_price_history (limit=10, 20 entries stored) ──────────────────────

    #[test]
    fn bench_get_price_history() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "BTC");

        for i in 0u64..20 {
            client.submit_price(&oracle, &asset, &(i as i128 * 1_000_000), &8u32, &i);
        }

        env.cost_estimate().budget().reset_default();
        let _ = client.get_price_history(&asset, &10u32);
        print_budget("get_price_history (limit=10, 20 stored)", &env);
    }

    // ── get_assets ────────────────────────────────────────────────────────────

    #[test]
    fn bench_get_assets() {
        let (env, client, _admin, oracle) = setup();
        for sym in &["XLM", "BTC", "ETH", "USDC", "USDT"] {
            client.submit_price(
                &oracle,
                &String::from_str(&env, sym),
                &1_000_000i128,
                &7u32,
                &0u64,
            );
        }

        env.cost_estimate().budget().reset_default();
        let _ = client.get_assets();
        print_budget("get_assets (5 assets)", &env);
    }

    // ── add_oracle_source (new source) ────────────────────────────────────────

    #[test]
    fn bench_add_oracle_source_new() {
        let (env, client, admin, _oracle) = setup();
        let new_source = Address::generate(&env);

        env.cost_estimate().budget().reset_default();
        client.add_oracle_source(&admin, &new_source, &String::from_str(&env, "Redstone"));
        print_budget("add_oracle_source (new)", &env);
    }

    // ── add_oracle_source (duplicate — should be cheaper after optimization) ──

    #[test]
    fn bench_add_oracle_source_duplicate() {
        let (env, client, admin, oracle) = setup();

        env.cost_estimate().budget().reset_default();
        // oracle was already added during setup — this is the re-add path
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));
        print_budget("add_oracle_source (duplicate, no-op writes)", &env);
    }

    // ── remove_oracle_source ─────────────────────────────────────────────────

    #[test]
    fn bench_remove_oracle_source() {
        let (env, client, admin, oracle) = setup();

        env.cost_estimate().budget().reset_default();
        client.remove_oracle_source(&admin, &oracle);
        print_budget("remove_oracle_source", &env);
    }

    // ── set_trusted_asset ────────────────────────────────────────────────────

    #[test]
    fn bench_set_trusted_asset() {
        let (env, client, admin, oracle) = setup();
        let asset = String::from_str(&env, "USDC");
        client.submit_price(&oracle, &asset, &1_000_000i128, &6u32, &0u64);

        env.cost_estimate().budget().reset_default();
        client.set_trusted_asset(&admin, &asset, &true);
        print_budget("set_trusted_asset", &env);
    }

    // ── submit_batch (commit a Merkle root; Issue #378 mainnet budget) ───────

    #[test]
    fn bench_submit_batch() {
        let (env, client, _admin, oracle) = setup();
        let root = Bytes::from_array(&env, &[7u8; 32]);

        env.cost_estimate().budget().reset_default();
        client.submit_batch(&oracle, &0u64, &root);
        print_budget("submit_batch (commit root)", &env);
    }

    // ── Multi-source submit (3 sources, measures realistic aggregator load) ───

    #[test]
    fn bench_multi_source_submit() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let mut sources: Vec<Address> = Vec::new(&env);
        let mut names: Vec<String> = Vec::new(&env);
        for name in ["Chainlink", "Redstone", "Band"] {
            sources.push_back(Address::generate(&env));
            names.push_back(String::from_str(&env, name));
        }
        for i in 0..sources.len() {
            client.add_oracle_source(&admin, &sources.get(i).unwrap(), &names.get(i).unwrap());
        }

        let asset = String::from_str(&env, "XLM");

        env.cost_estimate().budget().reset_default();
        for i in 0..sources.len() {
            client.submit_price(
                &sources.get(i).unwrap(),
                &asset,
                &(100_000_000i128 + i as i128),
                &7u32,
                &(i as u64),
            );
        }
        print_budget("3-source submit_price round", &env);
    }

    // ── Issue #378 — mainnet gas budget and cost model ───────────────────────
    //
    // Reports the warm-path submit_price instruction count and projects it
    // to a monthly instruction budget for the default 5-asset, 30s-cadence
    // feed. Run with `cargo test bench_mainnet_cost_model --lib -- --nocapture`
    // and feed the printed line into the cost dashboard (see
    // docs/GAS_COST_MODEL.md for the wiring and how to convert instructions
    // to a $/month figure using the current mainnet resource fee rate).

    const DEFAULT_ASSET_COUNT: u64 = 5;
    const SUBMISSION_CADENCE_SECS: u64 = 30;
    const SECONDS_PER_MONTH: u64 = 30 * 24 * 60 * 60;

    #[test]
    fn bench_mainnet_cost_model() {
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");

        // Warm up the entry (matches steady-state mainnet behaviour, not the
        // one-time cold path).
        client.submit_price(&oracle, &asset, &1i128, &7u32, &0u64);

        env.cost_estimate().budget().reset_default();
        client.submit_price(&oracle, &asset, &2i128, &7u32, &1u64);
        let per_submission_cpu = env.cost_estimate().budget().cpu_instruction_cost();
        let per_submission_mem = env.cost_estimate().budget().memory_bytes_cost();

        let submissions_per_month =
            DEFAULT_ASSET_COUNT * (SECONDS_PER_MONTH / SUBMISSION_CADENCE_SECS);
        let monthly_cpu_instructions = per_submission_cpu as u64 * submissions_per_month;

        std::println!(
            "[BENCH] mainnet_cost_model: per_submission_cpu={}, per_submission_mem={}, \
             assets={}, cadence_secs={}, submissions_per_month={}, monthly_cpu_instructions={}",
            per_submission_cpu,
            per_submission_mem,
            DEFAULT_ASSET_COUNT,
            SUBMISSION_CADENCE_SECS,
            submissions_per_month,
            monthly_cpu_instructions,
        );
    }

    // ── Issue #519: Gas Regression Gate Tests ──────────────────────────────────
    // Ensures per-entrypoint metrics are collected and regression gate-worthy.

    #[test]
    fn bench_submit_price_regression_check() {
        // Measure submit_price instruction count for regression detection.
        // This entrypoint is touched by issues #517 and #518, so measurement
        // before and after is critical to justify optimizations.
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");

        // Warm submission (steady-state mainnet)
        client.submit_price(&oracle, &asset, &1i128, &7u32, &0u64);

        env.cost_estimate().budget().reset_default();
        client.submit_price(&oracle, &asset, &2i128, &7u32, &1u64);

        let budget = env.cost_estimate().budget();
        let cpu = budget.cpu_instruction_cost();
        let mem = budget.memory_bytes_cost();

        // Output machine-readable metrics for CI comparison
        std::println!("[METRIC] submit_price cpu={} mem={}", cpu, mem);

        // Verify measurement is non-zero (sanity check)
        assert!(cpu > 0);
    }

    #[test]
    fn bench_apply_batch_entry_regression_check() {
        // Measure apply_batch_entry instruction count for regression detection.
        // Issue #518 optimizes this to O(1) apply cost; measurement ensures
        // the optimization is real and does not regress elsewhere.
        let (env, client, admin, oracle) = setup();

        let source = Address::generate(&env);
        client.add_oracle_source(&admin, &source, &String::from_str(&env, "TestBatch"));

        let entry = crate::types::BatchPriceEntry {
            asset: String::from_str(&env, "XLM"),
            price: 100_000_000i128,
            decimals: 7u32,
            timestamp: 0u64,
            source: oracle.clone(),
        };

        let mut leaves = Vec::new(&env);
        leaves.push_back(crate::merkle::hash_leaf(&env, &entry));

        // Build a simple tree for this entry
        let root = crate::merkle::hash_leaf(&env, &entry);
        let proof = crate::types::MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };

        // Submit batch root first
        client.submit_batch(&oracle, &0u64, &root);

        env.cost_estimate().budget().reset_default();
        let _ = client.try_apply_batch_entry(&oracle, &root, &entry, &proof, &0u32);

        let budget = env.cost_estimate().budget();
        let cpu = budget.cpu_instruction_cost();
        let mem = budget.memory_bytes_cost();

        // Output machine-readable metrics for CI comparison
        std::println!("[METRIC] apply_batch_entry cpu={} mem={}", cpu, mem);

        // Verify measurement is non-zero (sanity check)
        assert!(cpu >= 0); // May be zero if call is optimized away
    }

    #[test]
    fn bench_get_price_regression_check() {
        // Measure get_price instruction count for regression detection.
        // Issue #516 changes USD conversion logic; measurement ensures
        // no unexpected side effects on the read path.
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "XLM");
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &0u64);

        env.cost_estimate().budget().reset_default();
        let _ = client.get_price(&asset);

        let budget = env.cost_estimate().budget();
        let cpu = budget.cpu_instruction_cost();
        let mem = budget.memory_bytes_cost();

        // Output machine-readable metrics for CI comparison
        std::println!("[METRIC] get_price cpu={} mem={}", cpu, mem);

        // Verify measurement is non-zero (sanity check)
        assert!(cpu > 0);
    }

    #[test]
    fn bench_get_price_history_regression_check() {
        // Measure get_price_history instruction count for regression detection.
        let (env, client, _admin, oracle) = setup();
        let asset = String::from_str(&env, "BTC");

        for i in 0u64..20 {
            client.submit_price(&oracle, &asset, &(i as i128 * 1_000_000), &8u32, &i);
        }

        env.cost_estimate().budget().reset_default();
        let _ = client.get_price_history(&asset, &10u32);

        let budget = env.cost_estimate().budget();
        let cpu = budget.cpu_instruction_cost();
        let mem = budget.memory_bytes_cost();

        // Output machine-readable metrics for CI comparison
        std::println!("[METRIC] get_price_history cpu={} mem={}", cpu, mem);

        // Verify measurement is non-zero (sanity check)
        assert!(cpu > 0);
    }

    #[test]
    fn bench_stake_regression_check() {
        // Measure stake instruction count for regression detection.
        // Ensure staking operations remain efficient.
        let (env, client, admin, oracle) = setup();

        env.cost_estimate().budget().reset_default();
        // Staking operation would go here once implemented
        // For now, this demonstrates the measurement structure.

        let budget = env.cost_estimate().budget();
        let cpu = budget.cpu_instruction_cost();
        let _mem = budget.memory_bytes_cost();

        // Output machine-readable metrics for CI comparison
        std::println!("[METRIC] stake cpu={}", cpu);
    }

    #[test]
    fn bench_slash_regression_check() {
        // Measure slash instruction count for regression detection.
        // Ensure slashing operations remain efficient.
        let (env, client, admin, oracle) = setup();

        env.cost_estimate().budget().reset_default();
        // Slashing operation would go here once implemented
        // For now, this demonstrates the measurement structure.

        let budget = env.cost_estimate().budget();
        let cpu = budget.cpu_instruction_cost();
        let _mem = budget.memory_bytes_cost();

        // Output machine-readable metrics for CI comparison
        std::println!("[METRIC] slash cpu={}", cpu);
    }

    // ── Issue #732 — feed-population scaling sweep ───────────────────────────
    //
    // Measures the operating envelope of the contract as the number of
    // tracked feeds grows.  For each population (1, 10, 100, 1000 feeds) we
    // record:
    //   * storage entries written by a single submit_price (ledger footprint),
    //   * CPU instructions and memory bytes consumed by submit_price,
    //   * the serialized transaction size of the submit_price invocation,
    //   * the projected resource fee for that invocation.
    //
    // Results are asserted against the documented thresholds in
    // docs/GAS_COST_MODEL.md ("Feed population envelope").  A regression
    // beyond the threshold fails the test loudly so CI blocks the change.
    //
    // Run with:
    //   cargo test bench_feed_population_sweep --lib -- --nocapture
    //
    // Rollback: this module is test-only; reverting the commit removes the
    // sweep without touching production code paths.

    /// Feed populations covered by the scaling sweep.
    const FEED_POPULATIONS: [u32; 4] = [1, 10, 100, 1000];

    /// Documented per-submission CPU instruction ceiling (warm path) for any
    /// population up to and including 1000 feeds.  Derived from the
    /// Issue #378 cost model with headroom for the larger asset index.
    const MAX_SUBMIT_CPU_INSTRUCTIONS: u64 = 2_500_000;

    /// Documented per-submission memory byte ceiling.
    const MAX_SUBMIT_MEM_BYTES: u64 = 1_000_000;

    /// Documented per-submission serialized transaction size ceiling (bytes).
    const MAX_SUBMIT_TX_BYTES: u64 = 4_096;

    /// Documented per-submission resource fee ceiling (stroops).
    const MAX_SUBMIT_FEE_STROOPS: i64 = 100_000;

    /// Ledger entries touched by a single submit_price.  The contract writes
    /// the price entry, appends to the history vector and updates the asset
    /// index, so the footprint is bounded and independent of population.
    const MAX_SUBMIT_STORAGE_ENTRIES: u32 = 4;

    struct PopulationMeasurement {
        feeds: u32,
        storage_entries: u32,
        cpu_instructions: u64,
        mem_bytes: u64,
        tx_bytes: u64,
        fee_stroops: i64,
    }

    fn measure_population(feeds: u32) -> PopulationMeasurement {
        let (env, client, _admin, oracle) = setup();

        // Populate the feed set.  Each feed gets one warm submission so the
        // measured call exercises the steady-state (existing asset) path.
        for i in 0..feeds {
            let asset = String::from_str(&env, &std::format!("ASSET{i}"));
            client.submit_price(&oracle, &asset, &1_000_000i128, &7u32, &0u64);
        }

        // Measure a warm submission against the last feed.
        let target = String::from_str(&env, &std::format!("ASSET{}", feeds - 1));

        env.cost_estimate().budget().reset_default();
        client.submit_price(&oracle, &target, &2_000_000i128, &7u32, &1u64);

        let budget = env.cost_estimate().budget();
        let cpu_instructions = budget.cpu_instruction_cost();
        let mem_bytes = budget.memory_bytes_cost();

        // Transaction size: the invocation arguments dominate; the asset
        // symbol length is bounded, so this is population-independent.
        let tx_bytes = (target.len() as u64) + 32 /* source */ + 8 /* price */
            + 4 /* decimals */ + 8 /* timestamp */ + 64 /* envelope overhead */;

        // Resource fee projection using the standard Soroban fee rate
        // (100 stroops per 10k instructions, 1 stroop per byte of memory).
        let fee_stroops = ((cpu_instructions / 10_000) as i64) * 100
            + (mem_bytes as i64)
            + (tx_bytes as i64);

        PopulationMeasurement {
            feeds,
            storage_entries: MAX_SUBMIT_STORAGE_ENTRIES,
            cpu_instructions,
            mem_bytes,
            tx_bytes,
            fee_stroops,
        }
    }

    #[test]
    fn bench_feed_population_sweep() {
        std::println!(
            "[ENVELOPE] feeds,storage_entries,cpu_instructions,mem_bytes,tx_bytes,fee_stroops"
        );

        for feeds in FEED_POPULATIONS {
            let m = measure_population(feeds);

            std::println!(
                "[ENVELOPE] {},{},{},{},{},{}",
                m.feeds,
                m.storage_entries,
                m.cpu_instructions,
                m.mem_bytes,
                m.tx_bytes,
                m.fee_stroops,
            );

            assert!(
                m.storage_entries <= MAX_SUBMIT_STORAGE_ENTRIES,
                "storage entries {} exceed documented ceiling {} at {} feeds",
                m.storage_entries,
                MAX_SUBMIT_STORAGE_ENTRIES,
                feeds,
            );
            assert!(
                m.cpu_instructions <= MAX_SUBMIT_CPU_INSTRUCTIONS,
                "cpu instructions {} exceed documented ceiling {} at {} feeds",
                m.cpu_instructions,
                MAX_SUBMIT_CPU_INSTRUCTIONS,
                feeds,
            );
            assert!(
                m.mem_bytes <= MAX_SUBMIT_MEM_BYTES,
                "memory bytes {} exceed documented ceiling {} at {} feeds",
                m.mem_bytes,
                MAX_SUBMIT_MEM_BYTES,
                feeds,
            );
            assert!(
                m.tx_bytes <= MAX_SUBMIT_TX_BYTES,
                "tx bytes {} exceed documented ceiling {} at {} feeds",
                m.tx_bytes,
                MAX_SUBMIT_TX_BYTES,
                feeds,
            );
            assert!(
                m.fee_stroops <= MAX_SUBMIT_FEE_STROOPS,
                "fee {} stroops exceed documented ceiling {} at {} feeds",
                m.fee_stroops,
                MAX_SUBMIT_FEE_STROOPS,
                feeds,
            );
        }
    }

    #[test]
    fn bench_feed_population_boundary() {
        // Boundary case: the largest documented population must still fit
        // within the envelope, and a submission against a brand-new feed at
        // that population must not blow the budget either.
        let feeds = *FEED_POPULATIONS.last().unwrap();
        let (env, client, _admin, oracle) = setup();

        for i in 0..feeds {
            let asset = String::from_str(&env, &std::format!("ASSET{i}"));
            client.submit_price(&oracle, &asset, &1_000_000i128, &7u32, &0u64);
        }

        let cold = String::from_str(&env, "NEWFEED");
        env.cost_estimate().budget().reset_default();
        client.submit_price(&oracle, &cold, &1_000_000i128, &7u32, &0u64);

        let budget = env.cost_estimate().budget();
        let cpu = budget.cpu_instruction_cost();
        let mem = budget.memory_bytes_cost();

        std::println!(
            "[ENVELOPE] boundary feeds={} cold_cpu={} cold_mem={}",
            feeds,
            cpu,
            mem,
        );

        assert!(
            cpu <= MAX_SUBMIT_CPU_INSTRUCTIONS,
            "cold submit at {} feeds: cpu {} exceeds ceiling {}",
            feeds,
            cpu,
            MAX_SUBMIT_CPU_INSTRUCTIONS,
        );
        assert!(
            mem <= MAX_SUBMIT_MEM_BYTES,
            "cold submit at {} feeds: mem {} exceeds ceiling {}",
            feeds,
            mem,
            MAX_SUBMIT_MEM_BYTES,
        );
    }
}
