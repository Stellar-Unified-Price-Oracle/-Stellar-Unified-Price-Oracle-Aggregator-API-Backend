use soroban_sdk::{Address, Env, String, Vec};

use crate::contract::PriceOracleContract;
use crate::contract::PriceOracleContractClient;
use crate::errors::OracleError;
use crate::types::AssetPrice;

fn setup() -> (Env, PriceOracleContractClient<'static>, Address, Address) {
    let env = Env::default();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);

    client.initialize(&admin);
    client.add_oracle_source(&admin, &oracle, &String::from_slice(&env, b"Chainlink"));

    (env, client, admin, oracle)
}

#[test]
fn test_initialize_and_submit() {
    let (env, client, _admin, oracle) = setup();

    let asset = String::from_slice(&env, b"XLM");
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
fn test_unauthorized_source_rejected() {
    let (env, client, _admin, _oracle) = setup();
    let unauthorized = Address::generate(&env);

    let asset = String::from_slice(&env, b"XLM");
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
    let asset = String::from_slice(&env, b"BTC");

    for i in 1..=10 {
        let price = i as i128 * 100_000_000;
        client.submit_price(&oracle, &asset, &price, &8u32, &(env.ledger().timestamp() + i as u64));
    }

    let full = client.get_price_history(&asset, &100u32);
    assert_eq!(full.len(), 10);

    let window = client.get_price_history(&asset, &3u32);
    assert_eq!(window.len(), 3);
}

#[test]
fn test_trusted_asset_flag() {
    let (env, client, admin, oracle) = setup();

    let asset = String::from_slice(&env, b"USDC");
    client.submit_price(&oracle, &asset, &1_000_000i128, &6u32, &env.ledger().timestamp());
    client.set_trusted_asset(&admin, &asset, &true);

    let price: AssetPrice = client.get_price(&asset).expect("price exists");
    assert!(price.is_trusted);
}

#[test]
fn test_remove_oracle_source() {
    let (env, client, admin, oracle) = setup();

    client.remove_oracle_source(&admin, &oracle);

    let asset = String::from_slice(&env, b"XLM");
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
    let assets = vec![&env, b"XLM", b"BTC", b"ETH", b"USDC", b"USDT"];

    for asset_bytes in assets.iter() {
        let asset = String::from_slice(&env, asset_bytes);
        client.submit_price(&oracle, &asset, &1_000_000i128, &7u32, &env.ledger().timestamp());
    }

    let all_assets = client.get_assets();
    assert_eq!(all_assets.len(), 5);
}

#[test]
fn test_price_submission_idempotent() {
    let (env, client, _admin, oracle) = setup();
    let asset = String::from_slice(&env, b"XLM");

    client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &env.ledger().timestamp());
    client.submit_price(&oracle, &asset, &200_000_000i128, &7u32, &env.ledger().timestamp());

    let price: AssetPrice = client.get_price(&asset).expect("price exists");
    assert_eq!(price.price, 200_000_000);
}

#[test]
fn test_query_nonexistent_asset() {
    let (env, client, _admin, _oracle) = setup();

    let asset = String::from_slice(&env, b"NONEXISTENT");
    let price = client.get_price(&asset);
    assert!(price.is_none());
}

#[test]
fn test_admin_cannot_be_replaced_by_non_admin() {
    let env = Env::default();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let impersonator = Address::generate(&env);
    let oracle = Address::generate(&env);

    client.initialize(&admin);

    let result = client.try_add_oracle_source(
        &impersonator,
        &oracle,
        &String::from_slice(&env, b"Fail"),
    );
    assert!(result.is_err());
}

#[test]
fn test_invalid_decimals_handled() {
    let (env, client, _admin, oracle) = setup();
    let asset = String::from_slice(&env, b"XLM");

    // Submit with 0 decimals
    client.submit_price(&oracle, &asset, &100_000_000i128, &0u32, &env.ledger().timestamp());
    let price: AssetPrice = client.get_price(&asset).expect("price exists");
    assert_eq!(price.decimals, 0);
}

#[test]
fn test_oracle_source_management() {
    let (env, client, admin, oracle1) = setup();
    let oracle2 = Address::generate(&env);
    let oracle3 = Address::generate(&env);

    client.add_oracle_source(&admin, &oracle2, &String::from_slice(&env, b"Redstone"));
    client.add_oracle_source(&admin, &oracle3, &String::from_slice(&env, b"Band"));

    let asset = String::from_slice(&env, b"XLM");
    client.submit_price(&oracle1, &asset, &100n, &7u32, &env.ledger().timestamp());
    client.submit_price(&oracle2, &asset, &101n, &7u32, &env.ledger().timestamp());
    client.submit_price(&oracle3, &asset, &102n, &7u32, &env.ledger().timestamp());

    let price: AssetPrice = client.get_price(&asset).expect("price exists");
    assert_eq!(price.num_sources, 3);

    client.remove_oracle_source(&admin, &oracle2);

    let result = client.try_submit_price(&oracle2, &asset, &200n, &7u32, &env.ledger().timestamp());
    assert!(result.is_err());
}

#[test]
fn test_source_cannot_self_authorize() {
    let env = Env::default();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);

    client.initialize(&admin);

    let result = client.try_add_oracle_source(
        &oracle,
        &oracle,
        &String::from_slice(&env, b"Rogue"),
    );
    assert!(result.is_err());
}

#[test]
fn test_empty_history_returns_empty() {
    let (env, client, _admin, _oracle) = setup();
    let asset = String::from_slice(&env, b"XLM");

    let history = client.get_price_history(&asset, &10u32);
    assert_eq!(history.len(), 0);
}
