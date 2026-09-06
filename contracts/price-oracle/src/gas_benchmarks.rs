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

#[cfg(test)]
mod bench {
    extern crate std;
    use std::{println, vec, vec::Vec};

    use soroban_sdk::{
        testutils::{budget::Budget, Address as _},
        Address, Bytes, Env, String,
    };

    use crate::contract::{PriceOracleContract, PriceOracleContractClient};

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn setup() -> (Env, PriceOracleContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, PriceOracleContract);
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
        let id = env.register_contract(None, PriceOracleContract);
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

        env.budget().reset_default();
        client.submit_batch(&oracle, &0u64, &root);
        print_budget("submit_batch (commit root)", &env);
    }

    // ── Multi-source submit (3 sources, measures realistic aggregator load) ───

    #[test]
    fn bench_multi_source_submit() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, PriceOracleContract);
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
}
