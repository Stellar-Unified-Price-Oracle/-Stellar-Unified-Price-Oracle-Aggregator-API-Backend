#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Env, String as SorobanString};

use price_oracle::PriceOracleContract;
use price_oracle::contract::PriceOracleContractClient;

/// Structured input derived from raw fuzzer bytes.
#[derive(Arbitrary, Debug)]
struct SubmitPriceInput {
    /// Raw bytes turned into an asset symbol (sanitised to ASCII printable).
    asset_bytes: Vec<u8>,
    price: i128,
    decimals: u32,
    timestamp: u64,
    /// Whether the submitting address is the authorised oracle (true) or an
    /// unauthorised random address (false).
    use_authorized_source: bool,
}

fuzz_target!(|input: SubmitPriceInput| {
    let env = Env::default();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);

    client.initialize(&admin);
    client.add_oracle_source(&admin, &oracle, &SorobanString::from_str(&env, "Fuzzer"));

    // Build asset string from arbitrary bytes, normalised to ASCII printable.
    let asset_s = make_asset_string(&input.asset_bytes);
    let asset = SorobanString::from_str(&env, &asset_s);

    let caller = if input.use_authorized_source {
        oracle
    } else {
        Address::generate(&env)
    };

    // The contract must never panic; it may return an error for invalid inputs.
    let _ = client.try_submit_price(
        &caller,
        &asset,
        &input.price,
        &input.decimals,
        &input.timestamp,
    );

    // Invariant: if the call succeeded, get_price must return the submitted value.
    if input.use_authorized_source {
        if let Some(price) = client.get_price(&asset) {
            assert_eq!(price.price, input.price);
            assert_eq!(price.decimals, input.decimals);
        }
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
