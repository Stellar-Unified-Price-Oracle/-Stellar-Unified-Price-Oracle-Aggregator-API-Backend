// Issue #723 — Automated upgrade rehearsal test against production-shaped state.
#![cfg(test)]

use soroban_sdk::testutils::Address as TestAddress;
use soroban_sdk::{Address, Bytes, BytesN, Env, String, Vec};

use crate::contract::{PriceOracleContract, PriceOracleContractClient};
use crate::proxy::{ProxyContract, ProxyContractClient};
use crate::storage;
use crate::types::{AssetPrice, ProposalAction};

#[test]
fn test_rehearsal_against_production_shaped_state() {
    let env = Env::default();
    env.mock_all_auths();

    // ── 1. Seed production-shaped contract state ──────────────────────────────
    let contract_id = env.register(PriceOracleContract, ());
    let v1 = PriceOracleContractClient::new(&env, &contract_id);

    let admin = <Address as TestAddress>::generate(&env);
    let signer_a = <Address as TestAddress>::generate(&env);
    let signer_b = <Address as TestAddress>::generate(&env);
    let signer_c = <Address as TestAddress>::generate(&env);

    let oracle_chainlink = <Address as TestAddress>::generate(&env);
    let oracle_band = <Address as TestAddress>::generate(&env);
    let oracle_redstone = <Address as TestAddress>::generate(&env);

    v1.initialize(&admin);

    // Multi-sig governance setup
    let signers: Vec<Address> = Vec::from_array(
        &env,
        [signer_a.clone(), signer_b.clone(), signer_c.clone()],
    );
    v1.init_multisig(&admin, &signers, &2u32);

    // Authorized oracle sources
    v1.add_oracle_source(&admin, &oracle_chainlink, &String::from_str(&env, "Chainlink"));
    v1.add_oracle_source(&admin, &oracle_band, &String::from_str(&env, "Band"));
    v1.add_oracle_source(&admin, &oracle_redstone, &String::from_str(&env, "Redstone"));

    // Supported & trusted assets
    let xlm = String::from_str(&env, "XLM");
    let usdc = String::from_str(&env, "USDC");
    let btc = String::from_str(&env, "BTC");
    v1.set_trusted_asset(&admin, &xlm, &true);
    v1.set_trusted_asset(&admin, &usdc, &true);
    v1.set_trusted_asset(&admin, &btc, &true);

    let ts = env.ledger().timestamp();
    v1.submit_price(&oracle_chainlink, &xlm, &1_250_000i128, &7u32, &ts);
    v1.submit_price(&oracle_band, &xlm, &1_255_000i128, &7u32, &ts);
    v1.submit_price(&oracle_chainlink, &usdc, &10_000_000i128, &7u32, &ts);
    v1.submit_price(&oracle_redstone, &btc, &65_000_000_000i128, &7u32, &ts);

    // Deep price history (boundary test exceeding MAX_HISTORY_LEN)
    for i in 0..(storage::MAX_HISTORY_LEN + 15) {
        v1.submit_price(
            &oracle_chainlink,
            &xlm,
            &(1_250_000i128 + i as i128),
            &7u32,
            &(ts + i as u64 + 1),
        );
    }

    // Merkle batch submission
    let mut root_bytes = [5u8; 32];
    let root = Bytes::from_array(&env, &root_bytes);
    let batch_nonce_before = v1.submit_batch(&oracle_chainlink, &0u64, &root);

    // Feed catalog commitment
    let mut catalog_bytes = [9u8; 32];
    catalog_bytes[0] = 0xFE;
    let catalog_hash_before = BytesN::from_array(&env, &catalog_bytes);
    v1.commit_feed_catalog(&admin, &1u32, &catalog_hash_before);

    // Snapshot pre-upgrade state
    let assets_before = v1.get_assets();
    let xlm_before: AssetPrice = v1.get_price(&xlm).expect("xlm price must exist");
    let history_before = v1.get_price_history(&xlm, &200u32);
    let catalog_before = v1
        .get_feed_catalog_commitment()
        .expect("catalog commitment must exist");

    // ── 2. Execute Upgrade Rehearsal ──────────────────────────────────────────
    // Simulate WASM code replacement on existing contract instance
    env.register_at(&contract_id, ProxyContract, ());
    let v2 = ProxyContractClient::new(&env, &contract_id);

    // ── 3. Assert Invariants Post-Upgrade ─────────────────────────────────────
    assert_eq!(v2.get_assets(), assets_before);
    let xlm_after: AssetPrice = v2.get_price(&xlm).expect("xlm price must survive");
    assert_eq!(xlm_after.price, xlm_before.price);
    assert_eq!(xlm_after.decimals, xlm_before.decimals);
    assert_eq!(xlm_after.is_trusted, true);

    // History cap and ordering invariant
    let history_after = v2.get_price_history(&xlm, &200u32);
    assert_eq!(history_after.len(), storage::MAX_HISTORY_LEN);
    assert_eq!(history_after.len(), history_before.len());
    assert_eq!(
        history_after.get(history_after.len() - 1),
        history_before.get(history_before.len() - 1)
    );

    // Merkle batch nonce invariant
    let batch_nonce_after = env.as_contract(&contract_id, || storage::get_batch_nonce(&env));
    assert_eq!(batch_nonce_after, batch_nonce_before);

    // Governance config invariant
    let multisig_after = env
        .as_contract(&contract_id, || storage::get_multisig_config(&env))
        .expect("multisig config must survive");
    assert_eq!(multisig_after.threshold, 2u32);
    assert_eq!(multisig_after.signers.len(), 3);

    // Feed catalog commitment invariant
    assert_eq!(v2.get_feed_catalog_version(), 1u32);
    let catalog_after = v2
        .get_feed_catalog_commitment()
        .expect("catalog commitment must survive");
    assert_eq!(catalog_after.version, catalog_before.version);
    assert_eq!(catalog_after.catalog_hash, catalog_before.catalog_hash);
    assert_eq!(catalog_after.publisher, catalog_before.publisher);

    // ── 4. Verify Post-Upgrade Write Path & Governance Continuity ─────────────
    let mut catalog_v2_bytes = [9u8; 32];
    catalog_v2_bytes[0] = 0xFF;
    let catalog_hash_v2 = BytesN::from_array(&env, &catalog_v2_bytes);
    v2.commit_feed_catalog(&admin, &2u32, &catalog_hash_v2);
    assert_eq!(v2.get_feed_catalog_version(), 2u32);

    // ── 5. Rehearse Rollback Behavior ─────────────────────────────────────────
    // Rebind back to v1 implementation
    env.register_at(&contract_id, PriceOracleContract, ());
    let v1_rolled_back = PriceOracleContractClient::new(&env, &contract_id);

    assert_eq!(v1_rolled_back.get_assets(), assets_before);
    assert_eq!(v1_rolled_back.get_feed_catalog_version(), 2u32);
    let xlm_rollback = v1_rolled_back
        .get_price(&xlm)
        .expect("xlm price survives rollback");
    assert_eq!(xlm_rollback.price, xlm_before.price);
}
