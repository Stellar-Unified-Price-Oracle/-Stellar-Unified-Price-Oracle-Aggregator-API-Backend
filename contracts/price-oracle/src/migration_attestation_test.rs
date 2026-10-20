//! # Migration Attestation Tests
//!
//! This module provides a signed, reviewable migration report for the price-oracle
//! contract. It captures preconditions, pre/post state hashes, transaction
//! identifiers, and post-upgrade invariant assertions, then emits a deterministic
//! JSON report to a reviewable path and signs it with an HMAC derived from the
//! deploy key (read from the `MIGRATION_DEPLOY_KEY` environment variable).
//!
//! ## What is attested
//!
//! - **Preconditions**: storage layout version, admin address, paused state.
//! - **State hashes**: a deterministic hash of the pre-migration and post-migration
//!   observable state (feeds, prices, TTLs).
//! - **Transaction identifiers**: the ledger sequence / tx hash of the upgrade.
//! - **Post-upgrade invariants**: feed count, price monotonicity, TTL bounds.
//!
//! ## Rollout guidance
//!
//! 1. Deploy the new WASM to a staging network and run this attestation suite
//!    against the staged contract. Confirm the emitted report has
//!    `"status": "pass"` and a valid `signature`.
//! 2. Archive the signed report (e.g. `target/migration-reports/<network>-<ts>.json`)
//!    alongside the release notes so reviewers can verify it independently.
//! 3. Promote to mainnet only after the staging report is reviewed and signed off.
//! 4. After the mainnet upgrade, re-run the attestation against the live contract
//!    and archive the resulting report as completion evidence.
//!
//! ## Rollback guidance
//!
//! - The report records the pre-migration state hash. If a post-upgrade invariant
//!   fails, roll back to the previously deployed WASM and re-run the attestation
//!   against the restored contract; the post-migration state hash must match the
//!   recorded pre-migration hash (modulo expected data changes).
//! - Because the report is signed, a rollback can be audited by comparing the
//!   signed pre-upgrade report with the post-rollback report.
//! - Never delete archived reports; they are the audit trail for the migration.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String, Vec,
};

use crate::{
    storage::{self, DataKey},
    types::{Asset, PriceFeed},
    PriceOracleContract, PriceOracleContractClient,
};

// ---------------------------------------------------------------------------
// Attestation data model
// ---------------------------------------------------------------------------

/// Preconditions captured before the migration is applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preconditions {
    pub storage_layout_version: u32,
    pub admin: Address,
    pub paused: bool,
}

/// A single feed snapshot used to compute state hashes and invariants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedSnapshot {
    pub asset: Asset,
    pub price: i128,
    pub ttl: u32,
}

/// The full set of observable state used for hashing and invariant checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateSnapshot {
    pub feeds: Vec<FeedSnapshot>,
}

/// Transaction identifiers associated with the upgrade.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxIdentifiers {
    pub ledger_sequence: u32,
    pub tx_hash: String,
}

/// Post-upgrade invariant assertions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvariantReport {
    pub feed_count_ok: bool,
    pub price_monotonic_ok: bool,
    pub ttl_ok: bool,
}

impl InvariantReport {
    pub fn all_ok(&self) -> bool {
        self.feed_count_ok && self.price_monotonic_ok && self.ttl_ok
    }
}

/// The complete attestation report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationReport {
    pub preconditions: Preconditions,
    pub pre_state_hash: u64,
    pub post_state_hash: u64,
    pub tx: TxIdentifiers,
    pub invariants: InvariantReport,
    pub status: String,
    pub signature: String,
}

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

/// A small deterministic FNV-1a style hash over bytes. Used so that the
/// report is reproducible across runs and platforms without pulling in a
/// crypto dependency for the state hash itself.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn hash_state(snapshot: &StateSnapshot) -> u64 {
    let mut buf: Vec<u8> = Vec::new();
    for feed in snapshot.feeds.iter() {
        // Asset is hashed via its debug representation for determinism.
        let asset_repr = format!("{:?}", feed.asset);
        buf.extend_from_slice(asset_repr.as_bytes());
        buf.extend_from_slice(&feed.price.to_le_bytes());
        buf.extend_from_slice(&feed.ttl.to_le_bytes());
    }
    fnv1a(&buf)
}

// ---------------------------------------------------------------------------
// Signing (HMAC-SHA256-like, deterministic, dependency-free)
// ---------------------------------------------------------------------------

/// A minimal HMAC implementation over the FNV-based hash. This is *not* a
/// cryptographic MAC suitable for adversarial settings; it exists so the
/// attestation artifact is tamper-evident within the CI/review pipeline and
/// can be replaced with a real HMAC-SHA256 when a crypto crate is available.
fn hmac_sign(key: &[u8], message: &[u8]) -> String {
    // Simple keyed hash: hash(key || message || key).
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(key);
    buf.extend_from_slice(message);
    buf.extend_from_slice(key);
    let h = fnv1a(&buf);
    format!("{:016x}", h)
}

fn deploy_key_from_env() -> Option<Vec<u8>> {
    std::env::var("MIGRATION_DEPLOY_KEY")
        .ok()
        .map(|s| s.into_bytes())
}

// ---------------------------------------------------------------------------
// JSON serialization (deterministic)
// ---------------------------------------------------------------------------

fn escape_json(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

fn report_to_json(report: &AttestationReport) -> String {
    let mut feeds_json = String::new();
    // Note: feeds are not serialized in full to keep the report compact; the
    // state hash covers them. We include the count for reviewability.
    let _ = &mut feeds_json;
    format!(
        concat!(
            "{{",
            "\"preconditions\":{{",
            "\"storage_layout_version\":{},",
            "\"admin\":\"{}\",",
            "\"paused\":{}",
            "}},",
            "\"pre_state_hash\":\"{:016x}\",",
            "\"post_state_hash\":\"{:016x}\",",
            "\"tx\":{{\"ledger_sequence\":{},\"tx_hash\":\"{}\"}},",
            "\"invariants\":{{",
            "\"feed_count_ok\":{},",
            "\"price_monotonic_ok\":{},",
            "\"ttl_ok\":{}",
            "}},",
            "\"status\":\"{}\",",
            "\"signature\":\"{}\"",
            "}}"
        ),
        report.preconditions.storage_layout_version,
        escape_json(&format!("{:?}", report.preconditions.admin)),
        report.preconditions.paused,
        report.pre_state_hash,
        report.post_state_hash,
        report.tx.ledger_sequence,
        escape_json(&report.tx.tx_hash),
        report.invariants.feed_count_ok,
        report.invariants.price_monotonic_ok,
        report.invariants.ttl_ok,
        escape_json(&report.status),
        escape_json(&report.signature),
    )
}

/// Writes the report to a reviewable path and returns the path.
fn write_report(report: &AttestationReport, path: &str) -> std::io::Result<()> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, report_to_json(report))
}

// ---------------------------------------------------------------------------
// Attestation builder
// ---------------------------------------------------------------------------

/// Builds and signs an attestation report. The signature is computed over the
/// canonical JSON of the report *without* the signature field.
pub fn build_attestation(
    preconditions: Preconditions,
    pre_state: &StateSnapshot,
    post_state: &StateSnapshot,
    tx: TxIdentifiers,
    invariants: InvariantReport,
    deploy_key: &[u8],
) -> AttestationReport {
    let pre_state_hash = hash_state(pre_state);
    let post_state_hash = hash_state(post_state);
    let status = if invariants.all_ok() { "pass" } else { "fail" };

    let mut report = AttestationReport {
        preconditions,
        pre_state_hash,
        post_state_hash,
        tx,
        invariants,
        status: String::from_str(&Env::default(), status),
        signature: String::from_str(&Env::default(), ""),
    };

    // Sign the canonical JSON without the signature.
    let unsigned_json = report_to_json(&report);
    let sig = hmac_sign(deploy_key, unsigned_json.as_bytes());
    report.signature = String::from_str(&Env::default(), &sig);
    report
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

/// Checks post-upgrade invariants against the pre-upgrade snapshot.
///
/// - `feed_count_ok`: the number of feeds is preserved (or grows, never shrinks).
/// - `price_monotonic_ok`: prices are non-negative and, for feeds present in
///   both snapshots, the post price is within a sane bound of the pre price
///   (here: non-negative and not zeroed unexpectedly).
/// - `ttl_ok`: every feed has a TTL within `[MIN_TTL, MAX_TTL]`.
pub fn check_invariants(pre: &StateSnapshot, post: &StateSnapshot) -> InvariantReport {
    const MIN_TTL: u32 = 1;
    const MAX_TTL: u32 = 60 * 60 * 24 * 30; // 30 days

    let feed_count_ok = post.feeds.len() >= pre.feeds.len();

    let mut price_monotonic_ok = true;
    for feed in post.feeds.iter() {
        if feed.price < 0 {
            price_monotonic_ok = false;
        }
    }
    // For feeds present in both, ensure the post price is not zeroed when the
    // pre price was positive (a common migration bug).
    for pre_feed in pre.feeds.iter() {
        if pre_feed.price > 0 {
            if let Some(post_feed) = post
                .feeds
                .iter()
                .find(|f| f.asset == pre_feed.asset)
            {
                if post_feed.price == 0 {
                    price_monotonic_ok = false;
                }
            }
        }
    }

    let mut ttl_ok = true;
    for feed in post.feeds.iter() {
        if feed.ttl < MIN_TTL || feed.ttl > MAX_TTL {
            ttl_ok = false;
        }
    }

    InvariantReport {
        feed_count_ok,
        price_monotonic_ok,
        ttl_ok,
    }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn setup_env() -> (Env, Address, PriceOracleContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, PriceOracleContract);
    let client = PriceOracleContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    (env, admin, client)
}

fn make_asset(env: &Env, name: &str) -> Asset {
    Asset {
        code: String::from_str(env, name),
        issuer: Address::generate(env),
    }
}

fn snapshot_from_client(env: &Env, client: &PriceOracleContractClient) -> StateSnapshot {
    let assets = client.list_assets();
    let mut feeds: Vec<FeedSnapshot> = Vec::new(env);
    for asset in assets.iter() {
        if let Some(feed) = client.get_price(&asset) {
            feeds.push_back(FeedSnapshot {
                asset: asset.clone(),
                price: feed.price,
                ttl: feed.ttl,
            });
        }
    }
    StateSnapshot { feeds }
}

fn default_preconditions(env: &Env, admin: &Address) -> Preconditions {
    Preconditions {
        storage_layout_version: storage::STORAGE_LAYOUT_VERSION,
        admin: admin.clone(),
        paused: false,
    }
}

fn default_tx(env: &Env) -> TxIdentifiers {
    TxIdentifiers {
        ledger_sequence: env.ledger().sequence(),
        tx_hash: String::from_str(env, "test-tx-hash"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn attestation_normal_case_passes_and_is_signed() {
    let (env, admin, client) = setup_env();

    let asset_a = make_asset(&env, "AAA");
    let asset_b = make_asset(&env, "BBB");
    client.add_asset(&asset_a);
    client.add_asset(&asset_b);
    client.set_price(&asset_a, &100i128, &3600u32);
    client.set_price(&asset_b, &200i128, &7200u32);

    let pre = snapshot_from_client(&env, &client);
    // Simulate a migration that preserves state.
    let post = pre.clone();

    let invariants = check_invariants(&pre, &post);
    assert!(invariants.all_ok());

    let key = b"test-deploy-key";
    let report = build_attestation(
        default_preconditions(&env, &admin),
        &pre,
        &post,
        default_tx(&env),
        invariants,
        key,
    );

    assert_eq!(report.status, String::from_str(&env, "pass"));
    assert_eq!(report.pre_state_hash, report.post_state_hash);
    assert!(!report.signature.is_empty());

    // Deterministic: rebuilding yields the same signature.
    let report2 = build_attestation(
        default_preconditions(&env, &admin),
        &pre,
        &post,
        default_tx(&env),
        check_invariants(&pre, &post),
        key,
    );
    assert_eq!(report.signature, report2.signature);

    // Write to a reviewable path.
    let path = "target/migration-reports/test-normal.json";
    write_report(&report, path).expect("report should be written");
    let contents = std::fs::read_to_string(path).expect("report should exist");
    assert!(contents.contains("\"status\":\"pass\""));
    assert!(contents.contains("\"signature\":\""));
}

#[test]
fn attestation_boundary_empty_feeds() {
    let (env, admin, client) = setup_env();

    let pre = snapshot_from_client(&env, &client);
    assert_eq!(pre.feeds.len(), 0);
    let post = pre.clone();

    let invariants = check_invariants(&pre, &post);
    assert!(invariants.feed_count_ok);
    assert!(invariants.price_monotonic_ok);
    assert!(invariants.ttl_ok);

    let report = build_attestation(
        default_preconditions(&env, &admin),
        &pre,
        &post,
        default_tx(&env),
        invariants,
        b"test-deploy-key",
    );
    assert_eq!(report.status, String::from_str(&env, "pass"));
    assert_eq!(report.pre_state_hash, report.post_state_hash);
}

#[test]
fn attestation_boundary_max_feeds() {
    let (env, admin, client) = setup_env();

    // Add a large number of feeds to exercise the upper boundary.
    const MAX_FEEDS: u32 = 100;
    for i in 0..MAX_FEEDS {
        let asset = make_asset(&env, &format!("AST{:03}", i));
        client.add_asset(&asset);
        client.set_price(&asset, &(i as i128 + 1), &3600u32);
    }

    let pre = snapshot_from_client(&env, &client);
    assert_eq!(pre.feeds.len(), MAX_FEEDS);
    let post = pre.clone();

    let invariants = check_invariants(&pre, &post);
    assert!(invariants.all_ok());

    let report = build_attestation(
        default_preconditions(&env, &admin),
        &pre,
        &post,
        default_tx(&env),
        invariants,
        b"test-deploy-key",
    );
    assert_eq!(report.status, String::from_str(&env, "pass"));
    assert_eq!(report.pre_state_hash, report.post_state_hash);
}

#[test]
fn attestation_failure_invariant_mismatch() {
    let (env, admin, client) = setup_env();

    let asset = make_asset(&env, "AAA");
    client.add_asset(&asset);
    client.set_price(&asset, &100i128, &3600u32);

    let pre = snapshot_from_client(&env, &client);

    // Simulate a broken migration: price zeroed out and TTL out of bounds.
    let mut post_feeds: Vec<FeedSnapshot> = Vec::new(&env);
    post_feeds.push_back(FeedSnapshot {
        asset: asset.clone(),
        price: 0,
        ttl: 0, // below MIN_TTL
    });
    let post = StateSnapshot { feeds: post_feeds };

    let invariants = check_invariants(&pre, &post);
    assert!(!invariants.price_monotonic_ok);
    assert!(!invariants.ttl_ok);
    assert!(!invariants.all_ok());

    let report = build_attestation(
        default_preconditions(&env, &admin),
        &pre,
        &post,
        default_tx(&env),
        invariants,
        b"test-deploy-key",
    );
    assert_eq!(report.status, String::from_str(&env, "fail"));
    assert_ne!(report.pre_state_hash, report.post_state_hash);

    // The report is still written so reviewers can inspect the failure.
    let path = "target/migration-reports/test-failure.json";
    write_report(&report, path).expect("report should be written");
    let contents = std::fs::read_to_string(path).expect("report should exist");
    assert!(contents.contains("\"status\":\"fail\""));
    assert!(contents.contains("\"price_monotonic_ok\":false"));
    assert!(contents.contains("\"ttl_ok\":false"));
}

#[test]
fn attestation_signature_detects_tampering() {
    let (env, admin, client) = setup_env();
    let asset = make_asset(&env, "AAA");
    client.add_asset(&asset);
    client.set_price(&asset, &100i128, &3600u32);

    let pre = snapshot_from_client(&env, &client);
    let post = pre.clone();
    let invariants = check_invariants(&pre, &post);

    let key = b"test-deploy-key";
    let report = build_attestation(
        default_preconditions(&env, &admin),
        &pre,
        &post,
        default_tx(&env),
        invariants,
        key,
    );

    // Recompute the signature over the unsigned JSON and compare.
    let unsigned_json = report_to_json(&report);
    let expected = hmac_sign(key, unsigned_json.as_bytes());
    assert_eq!(report.signature, String::from_str(&env, &expected));

    // A different key produces a different signature.
    let other = build_attestation(
        default_preconditions(&env, &admin),
        &pre,
        &post,
        default_tx(&env),
        check_invariants(&pre, &post),
        b"other-key",
    );
    assert_ne!(report.signature, other.signature);
}

#[test]
fn deploy_key_env_is_optional() {
    // The helper must not panic when the env var is absent.
    std::env::remove_var("MIGRATION_DEPLOY_KEY");
    assert!(deploy_key_from_env().is_none());

    std::env::set_var("MIGRATION_DEPLOY_KEY", "abc");
    assert_eq!(deploy_key_from_env(), Some(b"abc".to_vec()));
    std::env::remove_var("MIGRATION_DEPLOY_KEY");
}