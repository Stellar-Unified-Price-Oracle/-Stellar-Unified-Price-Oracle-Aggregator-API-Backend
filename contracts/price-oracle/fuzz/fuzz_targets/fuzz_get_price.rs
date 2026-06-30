#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Env, String as SorobanString};

use price_oracle::PriceOracleContract;
use price_oracle::contract::PriceOracleContractClient;

/// A single price submission the fuzzer may insert before querying.
#[derive(Arbitrary, Debug)]
struct Submission {
    asset_bytes: Vec<u8>,
    price: i128,
    decimals: u32,
    timestamp: u64,
}

/// Full scenario input.
#[derive(Arbitrary, Debug)]
struct GetPriceInput {
    /// Zero or more price submissions to make before calling get_price.
    submissions: Vec<Submission>,
    /// Asset to query (may or may not match any submission).
    query_asset_bytes: Vec<u8>,
    /// History retrieval limit passed to get_price_history.
    history_limit: u32,
}

fuzz_target!(|input: GetPriceInput| {
    let env = Env::default();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);

    client.initialize(&admin);
    client.add_oracle_source(&admin, &oracle, &SorobanString::from_str(&env, "Fuzzer"));

    // Cap submissions to keep individual runs bounded.
    const MAX_SUBMISSIONS: usize = 64;

    let query_asset_s = make_asset_string(&input.query_asset_bytes);

    let mut submitted_for_query: u32 = 0;

    for sub in input.submissions.iter().take(MAX_SUBMISSIONS) {
        let asset_s = make_asset_string(&sub.asset_bytes);
        let asset = SorobanString::from_str(&env, &asset_s);
        let ok = client
            .try_submit_price(&oracle, &asset, &sub.price, &sub.decimals, &sub.timestamp)
            .is_ok();
        if ok && asset_s == query_asset_s {
            submitted_for_query += 1;
        }
    }

    let query_asset = SorobanString::from_str(&env, &query_asset_s);

    // get_price must never panic.
    let price_result = client.get_price(&query_asset);

    // get_price_history must never panic.
    let history = client.get_price_history(&query_asset, &input.history_limit);

    // Invariant: history length is bounded by min(submitted_for_query, history_limit).
    if price_result.is_some() {
        let expected_max = submitted_for_query.min(input.history_limit);
        assert!(
            history.len() <= expected_max,
            "history.len()={} > expected_max={} (submitted={}, limit={})",
            history.len(),
            expected_max,
            submitted_for_query,
            input.history_limit,
        );
    }
});

/// Sanitise raw bytes into a non-empty ASCII-printable string ≤ 32 chars.
fn make_asset_string(raw: &[u8]) -> std::string::String {
    let s: std::string::String = raw
        .iter()
        .map(|&b| if b.is_ascii_graphic() { b as char } else { 'X' })
        .take(32)
        .collect();
    if s.is_empty() {
        "DEFAULT".into()
    } else {
        s
    }
}
