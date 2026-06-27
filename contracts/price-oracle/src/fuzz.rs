use soroban_sdk::{Address, Env, String};
use soroban_sdk::testutils::Address as TestAddress;

use crate::contract::PriceOracleContract;
use crate::contract::PriceOracleContractClient;

fn setup_fuzz() -> (Env, PriceOracleContractClient<'static>, Address, Address) {
    let env = Env::default();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    let oracle = <Address as TestAddress>::generate(&env);

    client.initialize(&admin);
    client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));

    (env, client, admin, oracle)
}

#[test]
fn fuzz_submit_price_boundary_i128_max() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "XLM");

    let price_max = i128::MAX;
    let result = client.try_submit_price(
        &oracle,
        &asset,
        &price_max,
        &18u32,
        &env.ledger().timestamp(),
    );

    assert!(result.is_ok());
    let price = client.get_price(&asset).expect("price should exist");
    assert_eq!(price.price, price_max);
}

#[test]
fn fuzz_submit_price_boundary_i128_min() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "BTC");

    let price_min = i128::MIN + 1;
    let result = client.try_submit_price(
        &oracle,
        &asset,
        &price_min,
        &8u32,
        &env.ledger().timestamp(),
    );

    assert!(result.is_ok());
    let price = client.get_price(&asset).expect("price should exist");
    assert_eq!(price.price, price_min);
}

#[test]
fn fuzz_submit_price_zero() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "ETH");

    let result = client.try_submit_price(
        &oracle,
        &asset,
        &0i128,
        &18u32,
        &env.ledger().timestamp(),
    );

    assert!(result.is_ok());
    let price = client.get_price(&asset).expect("price should exist");
    assert_eq!(price.price, 0);
}

#[test]
fn fuzz_submit_price_negative() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "USDC");

    let result = client.try_submit_price(
        &oracle,
        &asset,
        &-1_000_000i128,
        &6u32,
        &env.ledger().timestamp(),
    );

    assert!(result.is_ok());
    let price = client.get_price(&asset).expect("price should exist");
    assert_eq!(price.price, -1_000_000);
}

#[test]
fn fuzz_submit_price_large_decimals() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "USDT");

    let result = client.try_submit_price(
        &oracle,
        &asset,
        &1_000_000i128,
        &u32::MAX,
        &env.ledger().timestamp(),
    );

    assert!(result.is_ok());
    let price = client.get_price(&asset).expect("price should exist");
    assert_eq!(price.decimals, u32::MAX);
}

#[test]
fn fuzz_add_oracle_source_duplicate_address() {
    let (env, client, admin, oracle) = setup_fuzz();

    let result = client.try_add_oracle_source(
        &admin,
        &oracle,
        &String::from_str(&env, "Redstone"),
    );

    assert!(result.is_ok());

    let asset = String::from_str(&env, "XLM");
    let submit_result = client.try_submit_price(
        &oracle,
        &asset,
        &500_000i128,
        &6u32,
        &env.ledger().timestamp(),
    );

    assert!(submit_result.is_ok());
}

#[test]
fn fuzz_add_oracle_source_same_address_twice() {
    let (env, client, admin, oracle) = setup_fuzz();

    let name = String::from_str(&env, "Band");
    let first_result = client.try_add_oracle_source(&admin, &oracle, &name);
    assert!(first_result.is_ok());

    let second_result = client.try_add_oracle_source(&admin, &oracle, &name);
    assert!(second_result.is_ok());
}

#[test]
fn fuzz_get_price_history_zero_limit() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "XLM");

    client.submit_price(
        &oracle,
        &asset,
        &100_000_000i128,
        &7u32,
        &env.ledger().timestamp(),
    );

    let history = client.get_price_history(&asset, &0u32);
    assert_eq!(history.len(), 0);
}

#[test]
fn fuzz_get_price_history_max_limit() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "BTC");

    for i in 1..=10 {
        client.submit_price(
            &oracle,
            &asset,
            &(i as i128 * 1_000_000i128),
            &8u32,
            &(env.ledger().timestamp() + i as u64),
        );
    }

    let history = client.get_price_history(&asset, &u32::MAX);
    assert_eq!(history.len(), 10);
}

#[test]
fn fuzz_get_price_history_limit_exceeds_entries() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "ETH");

    for i in 1..=5 {
        client.submit_price(
            &oracle,
            &asset,
            &(i as i128 * 100_000i128),
            &18u32,
            &(env.ledger().timestamp() + i as u64),
        );
    }

    let history = client.get_price_history(&asset, &1000u32);
    assert_eq!(history.len(), 5);
}

#[test]
fn fuzz_get_price_history_limit_one() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "USDC");

    for i in 1..=20 {
        client.submit_price(
            &oracle,
            &asset,
            &(i as i128 * 10_000i128),
            &6u32,
            &(env.ledger().timestamp() + i as u64),
        );
    }

    let history = client.get_price_history(&asset, &1u32);
    assert_eq!(history.len(), 1);

    if let Some(last_entry) = history.get(0) {
        assert_eq!(last_entry.price, 20 * 10_000i128);
    }
}

#[test]
fn fuzz_sequential_price_submissions_consistency() {
    let (env, client, _admin, oracle) = setup_fuzz();
    let asset = String::from_str(&env, "XLM");

    client.submit_price(&oracle, &asset, &100_000i128, &7u32, &(env.ledger().timestamp()));
    client.submit_price(&oracle, &asset, &1_000_000i128, &7u32, &(env.ledger().timestamp() + 1));
    client.submit_price(&oracle, &asset, &10_000_000i128, &7u32, &(env.ledger().timestamp() + 2));
    client.submit_price(&oracle, &asset, &(i128::MAX / 2), &7u32, &(env.ledger().timestamp() + 3));
    client.submit_price(&oracle, &asset, &-1_000_000i128, &7u32, &(env.ledger().timestamp() + 4));
    client.submit_price(&oracle, &asset, &0i128, &7u32, &(env.ledger().timestamp() + 5));

    let history = client.get_price_history(&asset, &u32::MAX);
    assert_eq!(history.len(), 6);

    let latest = client.get_price(&asset).expect("price should exist");
    assert_eq!(latest.price, 0i128);
}

#[test]
fn fuzz_multiple_sources_concurrent_submissions() {
    let env = Env::default();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    client.initialize(&admin);

    let oracle1 = <Address as TestAddress>::generate(&env);
    let oracle2 = <Address as TestAddress>::generate(&env);
    let oracle3 = <Address as TestAddress>::generate(&env);

    client.add_oracle_source(&admin, &oracle1, &String::from_str(&env, "Chainlink"));
    client.add_oracle_source(&admin, &oracle2, &String::from_str(&env, "Redstone"));
    client.add_oracle_source(&admin, &oracle3, &String::from_str(&env, "Band"));

    let asset = String::from_str(&env, "XLM");
    let timestamp = env.ledger().timestamp();

    client.submit_price(&oracle1, &asset, &100_000_000i128, &7u32, &timestamp);
    client.submit_price(&oracle2, &asset, &101_000_000i128, &7u32, &(timestamp + 1));
    client.submit_price(&oracle3, &asset, &102_000_000i128, &7u32, &(timestamp + 2));

    let history = client.get_price_history(&asset, &10u32);
    assert_eq!(history.len(), 3);
}

#[test]
fn fuzz_price_submission_timestamp_boundaries() {
    let (env, client, _admin, oracle) = setup_fuzz();

    let asset0 = String::from_str(&env, "BTC0");
    client.submit_price(&oracle, &asset0, &1_000_000i128, &8u32, &0u64);
    assert!(client.get_price(&asset0).is_some());

    let asset1 = String::from_str(&env, "BTC1");
    client.submit_price(&oracle, &asset1, &2_000_000i128, &8u32, &1u64);
    assert!(client.get_price(&asset1).is_some());

    let asset2 = String::from_str(&env, "BTC2");
    client.submit_price(&oracle, &asset2, &3_000_000i128, &8u32, &(u64::MAX / 2));
    assert!(client.get_price(&asset2).is_some());

    let asset3 = String::from_str(&env, "BTC3");
    client.submit_price(&oracle, &asset3, &4_000_000i128, &8u32, &(u64::MAX - 1));
    assert!(client.get_price(&asset3).is_some());
}

#[test]
fn fuzz_large_asset_name() {
    let (env, client, _admin, oracle) = setup_fuzz();

    let asset = String::from_str(&env, "VERYLONGASSETNAMETHATSHOULDSTILLWORK123456");

    let result = client.try_submit_price(
        &oracle,
        &asset,
        &500_000i128,
        &18u32,
        &env.ledger().timestamp(),
    );

    assert!(result.is_ok());
}
