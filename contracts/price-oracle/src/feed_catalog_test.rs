// Issue #725 — Feed catalog on-chain commitment tests
#![cfg(test)]

use soroban_sdk::testutils::Address as TestAddress;
use soroban_sdk::{Address, BytesN, Env, Vec};

use crate::contract::{PriceOracleContract, PriceOracleContractClient};
use crate::errors::OracleError;
use crate::proxy::{ProxyContract, ProxyContractClient};
use crate::types::{FeedCatalogCommitment, ProposalAction};

#[test]
fn test_admin_commit_feed_catalog_success() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PriceOracleContract, ());
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    client.initialize(&admin);

    assert_eq!(client.get_feed_catalog_version(), 0);
    assert_eq!(client.get_feed_catalog_commitment(), None);

    let mut cat_bytes_v1 = [1u8; 32];
    cat_bytes_v1[0] = 0xAA;
    let hash_v1 = BytesN::from_array(&env, &cat_bytes_v1);

    // Commit version 1
    client.commit_feed_catalog(&admin, &1u32, &hash_v1);

    assert_eq!(client.get_feed_catalog_version(), 1u32);
    let commitment = client
        .get_feed_catalog_commitment()
        .expect("commitment should exist");
    assert_eq!(commitment.version, 1u32);
    assert_eq!(commitment.catalog_hash, hash_v1);
    assert_eq!(commitment.publisher, admin);

    // Monotonic upgrade to version 2
    let mut cat_bytes_v2 = [2u8; 32];
    cat_bytes_v2[0] = 0xBB;
    let hash_v2 = BytesN::from_array(&env, &cat_bytes_v2);

    client.commit_feed_catalog(&admin, &2u32, &hash_v2);
    assert_eq!(client.get_feed_catalog_version(), 2u32);
    let commitment_v2 = client
        .get_feed_catalog_commitment()
        .expect("commitment v2 should exist");
    assert_eq!(commitment_v2.version, 2u32);
    assert_eq!(commitment_v2.catalog_hash, hash_v2);
}

#[test]
fn test_commit_feed_catalog_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PriceOracleContract, ());
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    let attacker = <Address as TestAddress>::generate(&env);
    client.initialize(&admin);

    let hash = BytesN::from_array(&env, &[1u8; 32]);
    let err = client.try_commit_feed_catalog(&attacker, &1u32, &hash);
    assert_eq!(err, Err(Ok(OracleError::AdminOnly)));
}

#[test]
fn test_commit_feed_catalog_rejects_version_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PriceOracleContract, ());
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    client.initialize(&admin);

    let hash = BytesN::from_array(&env, &[1u8; 32]);
    let err = client.try_commit_feed_catalog(&admin, &0u32, &hash);
    assert_eq!(err, Err(Ok(OracleError::InvalidCatalogVersion)));
}

#[test]
fn test_commit_feed_catalog_rejects_monotonicity_violation() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PriceOracleContract, ());
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    client.initialize(&admin);

    let hash = BytesN::from_array(&env, &[1u8; 32]);
    client.commit_feed_catalog(&admin, &5u32, &hash);

    // Replay same version 5 -> reject
    let err_same = client.try_commit_feed_catalog(&admin, &5u32, &hash);
    assert_eq!(err_same, Err(Ok(OracleError::InvalidCatalogVersion)));

    // Replay earlier version 4 -> reject
    let err_older = client.try_commit_feed_catalog(&admin, &4u32, &hash);
    assert_eq!(err_older, Err(Ok(OracleError::InvalidCatalogVersion)));
}

#[test]
fn test_multisig_commit_feed_catalog() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PriceOracleContract, ());
    let client = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    let signer1 = <Address as TestAddress>::generate(&env);
    let signer2 = <Address as TestAddress>::generate(&env);
    let signer3 = <Address as TestAddress>::generate(&env);

    client.initialize(&admin);

    let signers: Vec<Address> =
        Vec::from_array(&env, [signer1.clone(), signer2.clone(), signer3.clone()]);
    client.init_multisig(&admin, &signers, &2u32);

    let cat_hash = BytesN::from_array(&env, &[9u8; 32]);
    let action = ProposalAction::CommitFeedCatalog(1u32, cat_hash.clone());

    let prop_id = client.create_proposal(&signer1, &action);
    client.approve_proposal(&signer2, &prop_id);
    client.execute_proposal(&signer1, &prop_id);

    assert_eq!(client.get_feed_catalog_version(), 1u32);
    let commitment = client
        .get_feed_catalog_commitment()
        .expect("commitment should exist");
    assert_eq!(commitment.version, 1u32);
    assert_eq!(commitment.catalog_hash, cat_hash);
}

#[test]
fn test_proxy_commit_feed_catalog() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ProxyContract, ());
    let proxy = ProxyContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    let impl_addr = <Address as TestAddress>::generate(&env);
    proxy.initialize(&admin, &impl_addr);

    let cat_hash = BytesN::from_array(&env, &[7u8; 32]);
    proxy.commit_feed_catalog(&admin, &1u32, &cat_hash);

    assert_eq!(proxy.get_feed_catalog_version(), 1u32);
    let commitment = proxy
        .get_feed_catalog_commitment()
        .expect("proxy commitment should exist");
    assert_eq!(commitment.version, 1u32);
    assert_eq!(commitment.catalog_hash, cat_hash);
}
