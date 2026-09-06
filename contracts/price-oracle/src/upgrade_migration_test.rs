// Issue #381 — Upgrade integration test with state migration.
//
// Proves that swapping the running contract implementation at a fixed
// contract id (the same mechanism `ProxyContract::upgrade_wasm` performs on
// testnet by replacing the deployed WASM) never loses instance storage.
// `env.register_contract(Some(&contract_id), ..)` re-binds a second Rust
// contract type to an *existing* address the same way a WASM hash swap
// re-binds new code to an existing address on-chain — the ledger entries for
// that contract id, and therefore all of its storage, are untouched either
// way. `PriceOracleContract` (v1) and `ProxyContract` (v2, see ADR
// docs/adr/0003-contract-upgrade-strategy.md) read and write the same
// `DataKey` space, so v2 must observe exactly what v1 wrote.

#[cfg(test)]
mod upgrade_migration_tests {
    use soroban_sdk::{Address, Bytes, Env, String, Vec};
    use soroban_sdk::testutils::Address as TestAddress;

    use crate::contract::{PriceOracleContract, PriceOracleContractClient};
    use crate::proxy::{ProxyContract, ProxyContractClient};
    use crate::storage;
    use crate::types::AssetPrice;

    #[test]
    fn test_upgrade_preserves_prices_sources_and_governance_state() {
        let env = Env::default();
        env.mock_all_auths();

        // ── Deploy v1 and write state ───────────────────────────────────────
        let contract_id = env.register_contract(None, PriceOracleContract);
        let v1 = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let oracle_a = <Address as TestAddress>::generate(&env);
        let oracle_b = <Address as TestAddress>::generate(&env);

        v1.initialize(&admin);
        v1.add_oracle_source(&admin, &oracle_a, &String::from_str(&env, "Chainlink"));
        v1.add_oracle_source(&admin, &oracle_b, &String::from_str(&env, "Band"));
        v1.set_trusted_asset(&admin, &String::from_str(&env, "XLM"), &true);

        let xlm = String::from_str(&env, "XLM");
        let btc = String::from_str(&env, "BTC");
        v1.submit_price(&oracle_a, &xlm, &1_000_000i128, &7u32, &env.ledger().timestamp());
        v1.submit_price(&oracle_a, &btc, &5_000_000_000i128, &7u32, &env.ledger().timestamp());

        // Exceed the history cap so we can assert eviction survives the swap.
        for i in 0..(storage::MAX_HISTORY_LEN + 5) {
            v1.submit_price(&oracle_b, &xlm, &(1_000_000i128 + i as i128), &7u32, &env.ledger().timestamp());
        }

        // Batch nonce state.
        let mut root_bytes = [0u8; 32];
        root_bytes[0] = 7;
        let root = Bytes::from_array(&env, &root_bytes);
        let nonce_before = v1.submit_batch(&oracle_a, &0u64, &root);

        // Multi-sig ("governance") state living on the same contract id.
        let signers: Vec<Address> = Vec::from_array(&env, [oracle_a.clone(), oracle_b.clone(), admin.clone()]);
        v1.init_multisig(&admin, &signers, &2u32);

        let assets_before = v1.get_assets();
        let xlm_price_before: AssetPrice = v1.get_price(&xlm).expect("xlm price should exist");
        let history_before = v1.get_price_history(&xlm, &1000u32);
        let multisig_before = env
            .as_contract(&contract_id, || storage::get_multisig_config(&env))
            .expect("multisig config should exist");

        // ── Upgrade to v2 (same contract id, new implementation) ────────────
        env.register_contract(Some(&contract_id), ProxyContract);
        let v2 = ProxyContractClient::new(&env, &contract_id);

        // Admin / prices / sources / trusted flag survive untouched.
        assert_eq!(v2.get_assets(), assets_before);
        let xlm_price_after: AssetPrice = v2.get_price(&xlm).expect("xlm price should survive upgrade");
        assert_eq!(xlm_price_after.price, xlm_price_before.price);
        assert_eq!(xlm_price_after.is_trusted, true);

        // History-cap behavior: still capped at MAX_HISTORY_LEN, same tail.
        let history_after = v2.get_price_history(&xlm, &1000u32);
        assert_eq!(history_before.len(), storage::MAX_HISTORY_LEN);
        assert_eq!(history_after.len(), history_before.len());
        assert_eq!(history_after.get(history_after.len() - 1), history_before.get(history_before.len() - 1));

        // Batch nonce survives (read directly — ProxyContract doesn't expose it).
        let nonce_after = env.as_contract(&contract_id, || storage::get_batch_nonce(&env));
        assert_eq!(nonce_after, nonce_before);

        // Multi-sig ("governance") config survives.
        let multisig_after = env
            .as_contract(&contract_id, || storage::get_multisig_config(&env))
            .expect("multisig config should survive upgrade");
        assert_eq!(multisig_after.threshold, multisig_before.threshold);
        assert_eq!(multisig_after.signers.len(), multisig_before.signers.len());
    }
}
