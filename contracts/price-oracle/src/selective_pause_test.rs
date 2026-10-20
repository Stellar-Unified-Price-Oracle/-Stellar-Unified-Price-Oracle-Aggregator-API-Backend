//! # Selective Pause Recovery Tests (#731)
//!
//! This module specifies and tests safe recovery from *partial* service pauses
//! in the price oracle. A "selective pause" lets an operator pause individual
//! feeds (or a subset of service components) without disabling unrelated write
//! paths. Recovery must re-enable only the components that were paused, and
//! must never unintentionally re-enable unrelated write paths.
//!
//! ## Supported scope
//! - Pausing and unpausing individual feeds by identifier.
//! - Pausing all feeds and then recovering a subset.
//! - Rejecting unpause attempts from unauthorized callers.
//!
//! ## Owner
//! Soroban protocol evolution workstream (price-oracle maintainers).
//!
//! ## Recovery runbook
//! 1. **Identify** the paused feed(s) via `is_feed_paused` and the
//!    `FeedPaused` / `FeedUnpaused` events emitted on every transition.
//! 2. **Confirm root cause** before unpausing. Do not unpause a feed whose
//!    underlying data source is still unhealthy.
//! 3. **Unpause selectively** using the admin-gated `unpause_feed` entry point,
//!    one feed at a time, verifying each recovery with `is_feed_paused`.
//! 4. **Verify isolation**: after recovering a feed, confirm that feeds which
//!    were not paused remain writable and that feeds which remain paused still
//!    reject writes.
//! 5. **Record** the recovery in the operational log with the feed id, the
//!    operator identity, and the timestamp.
//!
//! ## Monitoring signals
//! - `FeedPaused` / `FeedUnpaused` events (per-feed transitions).
//! - Count of currently paused feeds (derived from `is_feed_paused`).
//! - Rejected unauthorized unpause attempts (surfaced as a failed call / error).
//! - Alert if a feed remains paused beyond the expected recovery window.
//!
//! ## Rollback guidance
//! - If a recovery is found to be incorrect, re-pause the affected feed with
//!   `pause_feed` (admin-gated). This is a safe, idempotent operation.
//! - Rollback is per-feed and does not affect other feeds or unrelated write
//!   paths.
//! - If the admin key is suspected compromised, rotate the admin before any
//!   further pause/unpause operations.

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

use crate::{PriceOracle, PriceOracleClient};

/// Helper: register the contract and return a client plus an admin address.
fn setup(env: &Env) -> (PriceOracleClient<'_>, Address) {
    let contract_id = env.register_contract(None, PriceOracle);
    let client = PriceOracleClient::new(env, &contract_id);
    let admin = Address::generate(env);
    env.mock_all_auths();
    client.initialize(&admin);
    (client, admin)
}

fn feed(env: &Env, name: &str) -> Symbol {
    Symbol::new(env, name)
}

/// Normal case: pause a single feed, recover it, and confirm that other feeds
/// are unaffected throughout.
#[test]
fn pause_one_feed_recover_it_others_unaffected() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let btc = feed(&env, "BTC");
    let eth = feed(&env, "ETH");
    let xlm = feed(&env, "XLM");

    // Baseline: nothing paused.
    assert!(!client.is_feed_paused(&btc));
    assert!(!client.is_feed_paused(&eth));
    assert!(!client.is_feed_paused(&xlm));

    // Pause only BTC.
    client.pause_feed(&btc);
    assert!(client.is_feed_paused(&btc));
    assert!(!client.is_feed_paused(&eth));
    assert!(!client.is_feed_paused(&xlm));

    // Recover BTC.
    client.unpause_feed(&btc);
    assert!(!client.is_feed_paused(&btc));

    // Others remain unaffected (still unpaused).
    assert!(!client.is_feed_paused(&eth));
    assert!(!client.is_feed_paused(&xlm));
}

/// Boundary case: pause all feeds, then recover only a subset. The recovered
/// subset must be writable while the remainder stays paused.
#[test]
fn pause_all_then_partial_recovery() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let feeds = [
        feed(&env, "BTC"),
        feed(&env, "ETH"),
        feed(&env, "XLM"),
        feed(&env, "USDC"),
    ];

    // Pause every feed.
    for f in feeds.iter() {
        client.pause_feed(f);
    }
    for f in feeds.iter() {
        assert!(client.is_feed_paused(f));
    }

    // Recover a subset (first two).
    client.unpause_feed(&feeds[0]);
    client.unpause_feed(&feeds[1]);

    assert!(!client.is_feed_paused(&feeds[0]));
    assert!(!client.is_feed_paused(&feeds[1]));
    // Remainder stays paused.
    assert!(client.is_feed_paused(&feeds[2]));
    assert!(client.is_feed_paused(&feeds[3]));

    // Recovering an already-unpaused feed is idempotent and safe.
    client.unpause_feed(&feeds[0]);
    assert!(!client.is_feed_paused(&feeds[0]));
}

/// Failure case: an unauthorized caller cannot unpause a feed.
#[test]
fn unauthorized_unpause_rejected() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let btc = feed(&env, "BTC");
    client.pause_feed(&btc);
    assert!(client.is_feed_paused(&btc));

    // Drop the blanket auth mock so the unauthorized caller's auth is not
    // satisfied by the admin.
    env.mock_auths(&[]);

    let result = client.try_unpause_feed(&btc);
    assert!(result.is_err(), "unauthorized unpause must be rejected");

    // Feed remains paused after the rejected attempt.
    assert!(client.is_feed_paused(&btc));
}

/// Failure case: an unauthorized caller cannot pause a feed either, ensuring
/// the recovery path is symmetric with the pause path.
#[test]
fn unauthorized_pause_rejected() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let btc = feed(&env, "BTC");
    env.mock_auths(&[]);

    let result = client.try_pause_feed(&btc);
    assert!(result.is_err(), "unauthorized pause must be rejected");
    assert!(!client.is_feed_paused(&btc));
}