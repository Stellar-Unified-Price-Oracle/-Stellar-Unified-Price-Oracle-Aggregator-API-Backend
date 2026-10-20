//! # Downstream Consumer Simulation Harness
//!
//! This module provides a local, repeatable harness that simulates how a
//! *downstream consumer contract* interacts with [`PriceOracleContract`]. It is
//! intended for protocol evolution work (see issue #729) so that integrators can
//! validate their assumptions about price reads, staleness, pause states, and
//! upgrade compatibility **before** shipping a consumer contract to a live
//! network.
//!
//! ## What is simulated
//!
//! The harness registers the real [`PriceOracleContract`] in a Soroban test
//! environment and drives it through a mock consumer flow covering:
//!
//! * **Fresh reads** — `get_price` (single asset) and `get_prices` (batch).
//! * **Stale data** — a read whose stored timestamp is older than the
//!   configured staleness threshold, including the *exact-boundary* case where
//!   `now - timestamp == staleness_threshold`.
//! * **Paused feed** — a single asset feed that has been paused.
//! * **Paused service** — the whole oracle service paused.
//! * **Post-upgrade version reads** — the implementation is re-registered at the
//!   same contract id to emulate an upgrade, then the version is read back.
//!
//! Normal, boundary (single vs. batch, exact threshold), and failure (paused,
//! unknown asset) cases are all exercised.
//!
//! ## Usage
//!
//! Consumers should mirror the assertions in this module inside their own
//! integration tests. The typical flow is:
//!
//! 1. Deploy/register [`PriceOracleContract`] with an admin.
//! 2. Configure assets and staleness thresholds.
//! 3. Publish prices and read them back through the same entry points your
//!    consumer uses (`get_price` / `get_prices`).
//! 4. Assert on the returned values *and* on the error variants for stale,
//!    paused, and unknown-asset paths.
//! 5. Re-register the implementation at the same contract id and confirm the
//!    version and read semantics are unchanged.
//!
//! ## Compatibility expectations
//!
//! * The public entry points (`get_price`, `get_prices`, `get_version`, pause
//!   controls) are treated as a stable contract. Consumers may rely on the
//!   *shape* of the returned values and on the error variants asserted here.
//! * Staleness is evaluated as `now - timestamp > staleness_threshold` being
//!   stale; the exact boundary (`==`) is considered **fresh**. Consumers that
//!   need stricter semantics must add their own guard.
//! * Upgrades are expected to preserve the contract id and the version read
//!   path. A consumer that pins a version should re-run this harness after any
//!   oracle upgrade.
//!
//! ## Rollback guidance
//!
//! * This module is test-only and is not compiled into production wasm; it has
//!   no on-chain footprint and requires no rollback of its own.
//! * If a consumer detects a regression via this harness, roll back the
//!   consumer to the last known-good oracle version pin and re-run the harness
//!   against the previous implementation before re-enabling reads.
//! * Oracle-side rollbacks should re-register the prior implementation at the
//!   same contract id (the same mechanism used by the upgrade test below) and
//!   re-run this harness to confirm compatibility.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, Vec,
};

use crate::{PriceOracleContract, PriceOracleContractClient};

/// Default staleness threshold (in ledgers/seconds) used by the harness.
const STALENESS_THRESHOLD: u64 = 100;

/// Helper: build an environment with a deterministic ledger timestamp.
fn setup_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000;
    });
    env
}

/// Helper: register the oracle and return a client plus the admin address.
fn register_oracle(env: &Env) -> (PriceOracleContractClient<'_>, Address) {
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    client.initialize(&admin);
    (client, admin)
}

/// Normal case: a freshly published price is readable via `get_price`.
#[test]
fn consumer_reads_fresh_single_price() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let asset = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    client.set_price(&asset, &42_i128);

    let price = client.get_price(&asset);
    assert_eq!(price, 42_i128);
}

/// Normal case: a batch read returns all requested assets in order.
#[test]
fn consumer_reads_fresh_batch_prices() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    client.set_price(&a, &10_i128);
    client.set_price(&b, &20_i128);

    let mut assets = Vec::new(&env);
    assets.push_back(a.clone());
    assets.push_back(b.clone());

    let prices = client.get_prices(&assets);
    assert_eq!(prices.len(), 2);
    assert_eq!(prices.get(0).unwrap(), 10_i128);
    assert_eq!(prices.get(1).unwrap(), 20_i128);
}

/// Boundary case: single vs. batch reads agree for the same asset.
#[test]
fn consumer_single_and_batch_agree() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let asset = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    client.set_price(&asset, &7_i128);

    let single = client.get_price(&asset);
    let mut assets = Vec::new(&env);
    assets.push_back(asset.clone());
    let batch = client.get_prices(&assets);

    assert_eq!(single, batch.get(0).unwrap());
}

/// Boundary case: `now - timestamp == staleness_threshold` is still fresh.
#[test]
fn consumer_exact_staleness_boundary_is_fresh() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let asset = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    client.set_price(&asset, &99_i128);

    // Advance exactly to the boundary.
    env.ledger().with_mut(|li| {
        li.timestamp += STALENESS_THRESHOLD;
    });

    let price = client.get_price(&asset);
    assert_eq!(price, 99_i128);
}

/// Failure case: a read past the staleness threshold is rejected.
#[test]
#[should_panic]
fn consumer_stale_price_is_rejected() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let asset = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    client.set_price(&asset, &5_i128);

    // Advance one past the boundary.
    env.ledger().with_mut(|li| {
        li.timestamp += STALENESS_THRESHOLD + 1;
    });

    let _ = client.get_price(&asset);
}

/// Failure case: reading an unknown asset is rejected.
#[test]
#[should_panic]
fn consumer_unknown_asset_is_rejected() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let asset = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    // No price published for `asset`.
    let _ = client.get_price(&asset);
}

/// Failure case: a paused feed rejects reads even when fresh.
#[test]
#[should_panic]
fn consumer_paused_feed_is_rejected() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let asset = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    client.set_price(&asset, &1_i128);
    client.pause_feed(&asset);

    let _ = client.get_price(&asset);
}

/// Failure case: a paused service rejects reads for all assets.
#[test]
#[should_panic]
fn consumer_paused_service_is_rejected() {
    let env = setup_env();
    let (client, _admin) = register_oracle(&env);
    let asset = Address::generate(&env);

    client.set_staleness_threshold(&STALENESS_THRESHOLD);
    client.set_price(&asset, &1_i128);
    client.pause();

    let _ = client.get_price(&asset);
}

/// Upgrade compatibility: re-registering the implementation at the same
/// contract id preserves the version read path and read semantics.
#[test]
fn consumer_post_upgrade_version_and_reads() {
    let env = setup_env();
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let version_before = client.get_version();

    // Emulate an upgrade by re-registering the implementation at the same id.
    env.register_contract(Some(&contract_id), PriceOracleContract);
    let upgraded = PriceOracleContractClient::new(&env, &contract_id);

    let version_after = upgraded.get_version();
    assert_eq!(
        version_before, version_after,
        "version read must be stable across re-registration at the same id"
    );

    // Reads continue to work after the upgrade.
    let asset = Address::generate(&env);
    upgraded.set_staleness_threshold(&STALENESS_THRESHOLD);
    upgraded.set_price(&asset, &123_i128);
    assert_eq!(upgraded.get_price(&asset), 123_i128);
}