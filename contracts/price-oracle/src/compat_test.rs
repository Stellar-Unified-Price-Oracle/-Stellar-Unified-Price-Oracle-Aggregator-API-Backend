// Issue #383 — ABI/interface compatibility test suite.
//
// Asserts the backwards-compatibility policy documented in
// docs/CONTRACT_VERSIONING.md:
//
//   1. The exported ABI version is a stable constant and queryable through
//      `get_api_version` on both the bare implementation and the proxy.
//   2. A state-preserving implementation swap — the same mechanism
//      `ProxyContract::upgrade_wasm` performs on testnet/mainnet by
//      re-binding new code to an existing contract id — leaves every v1
//      consumer read entrypoint returning identical data, so integrators
//      compiled against the v1 interface observe no behavioral change.
//
// This is the regression gate that must be extended on every release: any
// change to an exported entrypoint's argument/return shape must update the
// assertions below so a breaking ABI change cannot land silently.

#[cfg(test)]
mod compat_tests {
    use soroban_sdk::testutils::Address as TestAddress;
    use soroban_sdk::{Address, Env, String};

    use crate::contract::{PriceOracleContract, PriceOracleContractClient, API_VERSION};
    use crate::proxy::{ProxyContract, ProxyContractClient};
    use crate::types::{
        AssetPrice, PriceEvidence, PriceSnapshot, EVENT_SCHEMA_VERSION, SNAPSHOT_VERSION,
    };

    #[test]
    fn test_api_version_is_queryable_and_stable() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        assert_eq!(API_VERSION, 1, "first release exports ABI v1");
        assert_eq!(client.get_api_version(), API_VERSION);

        // The proxy (the production contract id consumers point at) must
        // expose the same version.
        let proxy_id = env.register(ProxyContract, ());
        let proxy = ProxyContractClient::new(&env, &proxy_id);
        assert_eq!(proxy.get_api_version(), API_VERSION);
    }

    /// Old clients keep working after an upgrade: a v1 client writes state,
    /// the implementation is swapped at the same contract id (the on-chain
    /// effect of `upgrade_wasm`), and every v1 read entrypoint returns
    /// exactly what it returned before the swap.
    #[test]
    fn test_v1_read_interface_survives_implementation_swap() {
        let env = Env::default();
        env.mock_all_auths();

        // ── Deploy v1 and write representative state ─────────────────────────
        let contract_id = env.register(PriceOracleContract, ());
        let v1 = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let oracle = <Address as TestAddress>::generate(&env);

        v1.initialize(&admin);
        v1.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));
        v1.add_oracle_source(
            &admin,
            &<Address as TestAddress>::generate(&env),
            &String::from_str(&env, "Band"),
        );
        v1.set_trusted_asset(&admin, &String::from_str(&env, "XLM"), &true);
        v1.set_deviation_threshold(&admin, &1_000u32);

        let xlm = String::from_str(&env, "XLM");
        let btc = String::from_str(&env, "BTC");
        v1.submit_price(
            &oracle,
            &xlm,
            &1_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );
        v1.submit_price(
            &oracle,
            &btc,
            &5_000_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );
        v1.submit_price(
            &oracle,
            &xlm,
            &1_100_000i128,
            &7u32,
            &(env.ledger().timestamp() + 1),
        );

        // Snapshot everything a v1 consumer can observe.
        let assets_before = v1.get_assets();
        let xlm_before: AssetPrice = v1.get_price(&xlm).expect("xlm price should exist");
        let btc_before: AssetPrice = v1.get_price(&btc).expect("btc price should exist");
        let history_before = v1.get_price_history(&xlm, &10u32);
        let threshold_before = v1.get_deviation_threshold();
        let reputation_before = v1.get_source_reputation(&oracle);

        // ── Upgrade: swap the implementation at the same contract id ─────────
        env.register_at(&contract_id, ProxyContract, ());
        let v2 = ProxyContractClient::new(&env, &contract_id);

        // Old clients keep working: identical results for every v1 read.
        assert_eq!(v2.get_assets(), assets_before);

        let xlm_after: AssetPrice = v2.get_price(&xlm).expect("xlm should survive upgrade");
        assert_eq!(xlm_after.price, xlm_before.price);
        assert_eq!(xlm_after.decimals, xlm_before.decimals);
        assert_eq!(xlm_after.timestamp, xlm_before.timestamp);
        assert_eq!(xlm_after.source, xlm_before.source);
        assert_eq!(xlm_after.num_sources, xlm_before.num_sources);
        assert_eq!(xlm_after.is_trusted, xlm_before.is_trusted);

        let btc_after: AssetPrice = v2.get_price(&btc).expect("btc should survive upgrade");
        assert_eq!(btc_after.price, btc_before.price);

        assert_eq!(v2.get_price_history(&xlm, &10u32), history_before);
        assert_eq!(v2.get_deviation_threshold(), threshold_before);
        assert_eq!(v2.get_source_reputation(&oracle), reputation_before);

        // Storage layout and deployment version are observable, and the ABI
        // version reported by the proxy is still v1.
        assert_eq!(v2.get_storage_layout_version(), 1);
        assert_eq!(v2.get_version(), 0, "proxy not yet versioned via upgrade()");
        assert_eq!(v2.get_api_version(), API_VERSION);
    }

    /// Issues #724/#726/#728 — the consumer-facing read surface added on top of
    /// v1 (`get_price_snapshot`, `get_price_evidence`, `verify_price_evidence`)
    /// must be byte-for-byte stable across an implementation swap, and the
    /// snapshot / event schema versions must not drift.
    #[test]
    fn test_consumer_read_surface_survives_implementation_swap() {
        let env = Env::default();
        env.mock_all_auths();

        // ── Deploy v1 and write representative state ─────────────────────────
        let contract_id = env.register(PriceOracleContract, ());
        let v1 = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let oracle = <Address as TestAddress>::generate(&env);

        v1.initialize(&admin);
        v1.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));
        v1.set_trusted_asset(&admin, &String::from_str(&env, "XLM"), &true);
        v1.set_deviation_threshold(&admin, &1_000u32);

        let xlm = String::from_str(&env, "XLM");
        let btc = String::from_str(&env, "BTC");
        v1.submit_price(
            &oracle,
            &xlm,
            &1_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );
        v1.submit_price(
            &oracle,
            &btc,
            &5_000_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        // Snapshot the new consumer read surface before the swap.
        let snapshot_before: PriceSnapshot = v1
            .get_price_snapshot(&xlm)
            .expect("xlm snapshot should exist");
        let evidence_before: PriceEvidence = v1
            .get_price_evidence(&xlm)
            .expect("xlm evidence should exist");
        let verified_before = v1.verify_price_evidence(&evidence_before);
        let btc_snapshot_before: PriceSnapshot = v1
            .get_price_snapshot(&btc)
            .expect("btc snapshot should exist");

        // Version constants are stable and queryable.
        assert_eq!(SNAPSHOT_VERSION, 1, "snapshot struct version is v1");
        assert_eq!(EVENT_SCHEMA_VERSION, 1, "event schema version is v1");
        assert_eq!(snapshot_before.version, SNAPSHOT_VERSION);
        assert_eq!(evidence_before.snapshot.version, SNAPSHOT_VERSION);
        assert_eq!(evidence_before.event_schema_version, EVENT_SCHEMA_VERSION);

        // ── Upgrade: swap the implementation at the same contract id ─────────
        env.register_at(&contract_id, ProxyContract, ());
        let v2 = ProxyContractClient::new(&env, &contract_id);

        // Identical results for every new consumer read.
        let snapshot_after: PriceSnapshot = v2
            .get_price_snapshot(&xlm)
            .expect("xlm snapshot should survive upgrade");
        assert_eq!(snapshot_after.version, snapshot_before.version);
        assert_eq!(snapshot_after.price, snapshot_before.price);
        assert_eq!(snapshot_after.decimals, snapshot_before.decimals);
        assert_eq!(snapshot_after.timestamp, snapshot_before.timestamp);
        assert_eq!(snapshot_after.policy_version, snapshot_before.policy_version);
        assert_eq!(snapshot_after.is_trusted, snapshot_before.is_trusted);

        let evidence_after: PriceEvidence = v2
            .get_price_evidence(&xlm)
            .expect("xlm evidence should survive upgrade");
        assert_eq!(
            evidence_after.event_schema_version,
            evidence_before.event_schema_version
        );
        assert_eq!(evidence_after.snapshot.version, evidence_before.snapshot.version);
        assert_eq!(evidence_after.snapshot.price, evidence_before.snapshot.price);
        assert_eq!(
            evidence_after.snapshot.policy_version,
            evidence_before.snapshot.policy_version
        );

        // Evidence produced before the swap still verifies under the new code.
        assert_eq!(v2.verify_price_evidence(&evidence_before), verified_before);
        assert_eq!(v2.verify_price_evidence(&evidence_after), verified_before);

        let btc_snapshot_after: PriceSnapshot = v2
            .get_price_snapshot(&btc)
            .expect("btc snapshot should survive upgrade");
        assert_eq!(btc_snapshot_after.price, btc_snapshot_before.price);
        assert_eq!(
            btc_snapshot_after.policy_version,
            btc_snapshot_before.policy_version
        );

        // Version constants remain stable after the swap.
        assert_eq!(v2.get_api_version(), API_VERSION);
        assert_eq!(snapshot_after.version, SNAPSHOT_VERSION);
        assert_eq!(evidence_after.event_schema_version, EVENT_SCHEMA_VERSION);
    }

    /// Boundary/failure cases for the consumer read surface: unknown assets
    /// yield no snapshot/evidence, and tampered evidence fails verification.
    #[test]
    fn test_consumer_read_surface_boundary_and_failure_cases() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let oracle = <Address as TestAddress>::generate(&env);
        client.initialize(&admin);
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));

        let xlm = String::from_str(&env, "XLM");
        let unknown = String::from_str(&env, "DOGE");

        // Unknown asset: no snapshot, no evidence.
        assert!(client.get_price_snapshot(&unknown).is_none());
        assert!(client.get_price_evidence(&unknown).is_none());

        client.submit_price(
            &oracle,
            &xlm,
            &1_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        let evidence: PriceEvidence = client
            .get_price_evidence(&xlm)
            .expect("xlm evidence should exist");
        assert!(client.verify_price_evidence(&evidence));

        // Tampered evidence must fail verification.
        let mut tampered = evidence.clone();
        tampered.snapshot.price = tampered.snapshot.price.saturating_add(1);
        assert!(!client.verify_price_evidence(&tampered));
    }

    /// Additive-style re-registration of the same ABI (a no-op WASM swap that
    /// keeps the interface intact) must not disturb any consumer-visible data.
    #[test]
    fn test_v1_interface_stable_across_redeploy_at_same_id() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let v1 = PriceOracleContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let oracle = <Address as TestAddress>::generate(&env);
        v1.initialize(&admin);
        v1.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));

        let asset = String::from_str(&env, "XLM");
        v1.submit_price(
            &oracle,
            &asset,
            &42_000_000i128,
            &7u32,
            &env.ledger().timestamp(),
        );

        let price_before: AssetPrice = v1.get_price(&asset).expect("price should exist");
        let history_before = v1.get_price_history(&asset, &5u32);
        let api_before = v1.get_api_version();

        // Same contract id, same ABI, implementation re-registered.
        env.register_at(&contract_id, PriceOracleContract, ());
        let v1_redeployed = PriceOracleContractClient::new(&env, &contract_id);

        let price_after: AssetPrice = v1_redeployed
            .get_price(&asset)
            .expect("price should survive redeploy");
        assert_eq!(price_after.price, price_before.price);
        assert_eq!(price_after.timestamp, price_before.timestamp);
        assert_eq!(
            v1_redeployed.get_price_history(&asset, &5u32),
            history_before
        );
        assert_eq!(v1_redeployed.get_api_version(), api_before);
    }
}
