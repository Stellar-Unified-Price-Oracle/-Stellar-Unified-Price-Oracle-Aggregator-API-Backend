use soroban_sdk::{Address, Env, String, Vec};

use crate::contract::PriceOracleContract;
use crate::contract::PriceOracleContractClient;
use crate::proxy::ProxyContract;
use crate::proxy::ProxyContractClient;
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

// Proxy contract tests
fn setup_proxy() -> (Env, ProxyContractClient<'static>, Address, Address, Address) {
    let env = Env::default();
    let proxy_id = env.register_contract(None, ProxyContract);
    let proxy_client = ProxyContractClient::new(&env, &proxy_id);

    let admin = Address::generate(&env);
    let implementation = Address::generate(&env);
    let oracle = Address::generate(&env);

    proxy_client.initialize(&admin, &implementation);
    proxy_client.add_oracle_source(&admin, &oracle, &String::from_slice(&env, b"Chainlink"));

    (env, proxy_client, admin, oracle, implementation)
}

#[test]
fn test_proxy_initialization() {
    let (env, proxy_client, admin, _oracle, implementation) = setup_proxy();

    let current_impl = proxy_client.get_implementation();
    assert_eq!(current_impl, Some(implementation));

    let version = proxy_client.get_version();
    assert_eq!(version, 1);
}

#[test]
fn test_proxy_data_preservation_on_upgrade() {
    let (env, proxy_client, admin, oracle, _old_impl) = setup_proxy();

    // Submit prices before upgrade
    let asset = String::from_slice(&env, b"XLM");
    proxy_client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &env.ledger().timestamp());

    // Verify data exists
    let price = proxy_client.get_price(&asset).expect("price should exist");
    assert_eq!(price.price, 100_000_000);
    assert_eq!(price.decimals, 7);

    // Perform upgrade
    let new_impl = Address::generate(&env);
    proxy_client.upgrade(&admin, &new_impl).expect("upgrade should succeed");

    // Verify version incremented
    let new_version = proxy_client.get_version();
    assert_eq!(new_version, 2);

    // Verify data is preserved after upgrade
    let price_after = proxy_client.get_price(&asset).expect("price should still exist");
    assert_eq!(price_after.price, 100_000_000);
    assert_eq!(price_after.decimals, 7);
    assert_eq!(price_after.asset, asset);
}

#[test]
fn test_proxy_tracks_previous_implementation() {
    let (env, proxy_client, admin, _oracle, old_impl) = setup_proxy();

    let new_impl = Address::generate(&env);
    proxy_client.upgrade(&admin, &new_impl).expect("upgrade should succeed");

    let previous = proxy_client.get_previous_implementation();
    assert_eq!(previous, Some(old_impl));

    let current = proxy_client.get_implementation();
    assert_eq!(current, Some(new_impl));
}

#[test]
fn test_proxy_admin_change() {
    let (env, proxy_client, admin, _oracle, _impl) = setup_proxy();
    let new_admin = Address::generate(&env);

    proxy_client.set_admin(&admin, &new_admin).expect("should change admin");

    // Attempt operation with new admin should work
    let oracle2 = Address::generate(&env);
    let result = proxy_client.add_oracle_source(&new_admin, &oracle2, &String::from_slice(&env, b"NewSource"));
    assert!(result.is_ok());

    // Attempt operation with old admin should fail
    let oracle3 = Address::generate(&env);
    let result = proxy_client.try_add_oracle_source(&admin, &oracle3, &String::from_slice(&env, b"ShouldFail"));
    assert!(result.is_err());
}

#[test]
fn test_proxy_upgrade_requires_admin() {
    let (env, proxy_client, _admin, oracle, _impl) = setup_proxy();
    let new_impl = Address::generate(&env);

    let result = proxy_client.try_upgrade(&oracle, &new_impl);
    assert!(result.is_err());
}

#[test]
fn test_proxy_multiple_upgrades_increment_version() {
    let (env, proxy_client, admin, _oracle, _impl) = setup_proxy();

    let impl2 = Address::generate(&env);
    proxy_client.upgrade(&admin, &impl2).expect("first upgrade");
    assert_eq!(proxy_client.get_version(), 2);

    let impl3 = Address::generate(&env);
    proxy_client.upgrade(&admin, &impl3).expect("second upgrade");
    assert_eq!(proxy_client.get_version(), 3);

    let impl4 = Address::generate(&env);
    proxy_client.upgrade(&admin, &impl4).expect("third upgrade");
    assert_eq!(proxy_client.get_version(), 4);
}
