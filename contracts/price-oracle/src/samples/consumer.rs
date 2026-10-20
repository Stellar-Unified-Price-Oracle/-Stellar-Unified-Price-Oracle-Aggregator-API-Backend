//! Sample consumer contract for the price oracle.
//!
//! This module demonstrates how a downstream contract can consume price
//! evidence from the price oracle, verify Merkle proofs against the oracle's
//! published root, and enforce caller-selected freshness (max-age) and
//! min/max price bounds.
//!
//! ## Scope
//! - Verifies Merkle inclusion proofs using [`crate::merkle`].
//! - Enforces a caller-selected maximum age (freshness) for the price
//!   timestamp.
//! - Enforces caller-selected inclusive `[min_price, max_price]` bounds.
//!
//! ## Operational notes
//! - Consumers should pick `max_age` based on their risk tolerance. A value of
//!   `0` disables the freshness check (not recommended for production).
//! - Consumers should pick bounds that reflect their tolerance for price
//!   volatility. `min_price == 0` disables the lower bound; `max_price ==
//!   u128::MAX` disables the upper bound.
//! - Rollout: deploy the consumer, point it at the oracle contract id, and
//!   verify with a known-good proof before routing traffic.
//! - Rollback: consumers are stateless with respect to verification; simply
//!   stop invoking the consumer and revert to the previous deployment.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, BytesN, Env};

use crate::merkle;

/// Errors returned by the sample consumer.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ConsumerError {
    /// The Merkle proof did not verify against the oracle root.
    InvalidProof = 1,
    /// The price timestamp is older than the caller-selected `max_age`.
    StalePrice = 2,
    /// The price is below the caller-selected `min_price`.
    PriceBelowMin = 3,
    /// The price is above the caller-selected `max_price`.
    PriceAboveMax = 4,
    /// The caller-supplied bounds are inconsistent (`min_price > max_price`).
    InvalidBounds = 5,
}

/// A verified price observation returned to the caller.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedPrice {
    /// The asset identifier the price refers to.
    pub asset: BytesN<32>,
    /// The verified price value.
    pub price: u128,
    /// The timestamp (ledger time) at which the price was observed.
    pub timestamp: u64,
}

/// Sample consumer contract.
#[contract]
pub struct SampleConsumer;

#[contractimpl]
impl SampleConsumer {
    /// Verify a price proof and enforce freshness and bounds.
    ///
    /// # Arguments
    /// - `root`: The oracle's published Merkle root.
    /// - `asset`: The asset identifier the price refers to.
    /// - `price`: The claimed price value.
    /// - `timestamp`: The claimed observation timestamp.
    /// - `proof`: The Merkle inclusion proof (sibling hashes).
    /// - `max_age`: Maximum allowed age in seconds. `0` disables the check.
    /// - `min_price`: Inclusive lower bound. `0` disables the check.
    /// - `max_price`: Inclusive upper bound. `u128::MAX` disables the check.
    ///
    /// # Returns
    /// A [`VerifiedPrice`] on success.
    ///
    /// # Errors
    /// - [`ConsumerError::InvalidBounds`] if `min_price > max_price`.
    /// - [`ConsumerError::InvalidProof`] if the proof does not verify.
    /// - [`ConsumerError::StalePrice`] if the price is too old.
    /// - [`ConsumerError::PriceBelowMin`] / [`ConsumerError::PriceAboveMax`]
    ///   if the price is out of bounds.
    #[allow(clippy::too_many_arguments)]
    pub fn verify_price(
        env: Env,
        root: BytesN<32>,
        asset: BytesN<32>,
        price: u128,
        timestamp: u64,
        proof: soroban_sdk::Vec<BytesN<32>>,
        max_age: u64,
        min_price: u128,
        max_price: u128,
    ) -> Result<VerifiedPrice, ConsumerError> {
        // Validate caller-supplied bounds first so misconfiguration fails fast.
        if min_price > max_price {
            return Err(ConsumerError::InvalidBounds);
        }

        // Verify the Merkle inclusion proof against the oracle root.
        let leaf = merkle::price_leaf(&env, &asset, price, timestamp);
        if !merkle::verify(&env, &root, &leaf, &proof) {
            return Err(ConsumerError::InvalidProof);
        }

        // Enforce freshness (max-age) if enabled.
        if max_age > 0 {
            let now = env.ledger().timestamp();
            // Guard against timestamps in the future relative to ledger time.
            if timestamp > now {
                return Err(ConsumerError::StalePrice);
            }
            let age = now - timestamp;
            if age > max_age {
                return Err(ConsumerError::StalePrice);
            }
        }

        // Enforce inclusive price bounds.
        if price < min_price {
            return Err(ConsumerError::PriceBelowMin);
        }
        if price > max_price {
            return Err(ConsumerError::PriceAboveMax);
        }

        Ok(VerifiedPrice {
            asset,
            price,
            timestamp,
        })
    }

    /// Convenience wrapper that verifies a price and returns only the value.
    ///
    /// See [`SampleConsumer::verify_price`] for argument semantics.
    #[allow(clippy::too_many_arguments)]
    pub fn verify_price_value(
        env: Env,
        root: BytesN<32>,
        asset: BytesN<32>,
        price: u128,
        timestamp: u64,
        proof: soroban_sdk::Vec<BytesN<32>>,
        max_age: u64,
        min_price: u128,
        max_price: u128,
    ) -> Result<u128, ConsumerError> {
        let verified = Self::verify_price(
            env, root, asset, price, timestamp, proof, max_age, min_price, max_price,
        )?;
        Ok(verified.price)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Ledger, LedgerInfo};
    use soroban_sdk::{BytesN, Env, Vec};

    fn asset(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    fn set_ledger_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 20,
            sequence_number: 1,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });
    }

    /// Build a single-leaf tree root and empty proof for the given leaf.
    fn single_leaf_root(env: &Env, leaf: &BytesN<32>) -> (BytesN<32>, Vec<BytesN<32>>) {
        // With one leaf, the root is the leaf itself and the proof is empty.
        (leaf.clone(), Vec::new(env))
    }

    fn setup() -> (Env, SampleConsumerClient<'static>) {
        let env = Env::default();
        let contract_id = env.register_contract(None, SampleConsumer);
        let client = SampleConsumerClient::new(&env, &contract_id);
        (env, client)
    }

    #[test]
    fn valid_proof_succeeds() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 1);
        let price: u128 = 100;
        let timestamp: u64 = 990;
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.verify_price(
            &root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(
            result,
            VerifiedPrice {
                asset: asset_id,
                price,
                timestamp,
            }
        );
    }

    #[test]
    fn stale_timestamp_rejected() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 2);
        let price: u128 = 100;
        let timestamp: u64 = 900; // 100s old
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.try_verify_price(
            &root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(result, Err(Ok(ConsumerError::StalePrice)));
    }

    #[test]
    fn future_timestamp_rejected() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 3);
        let price: u128 = 100;
        let timestamp: u64 = 1_100; // in the future
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.try_verify_price(
            &root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(result, Err(Ok(ConsumerError::StalePrice)));
    }

    #[test]
    fn price_below_min_rejected() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 4);
        let price: u128 = 10;
        let timestamp: u64 = 990;
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.try_verify_price(
            &root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(result, Err(Ok(ConsumerError::PriceBelowMin)));
    }

    #[test]
    fn price_above_max_rejected() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 5);
        let price: u128 = 500;
        let timestamp: u64 = 990;
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.try_verify_price(
            &root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(result, Err(Ok(ConsumerError::PriceAboveMax)));
    }

    #[test]
    fn tampered_proof_rejected() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 6);
        let price: u128 = 100;
        let timestamp: u64 = 990;
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, _proof) = single_leaf_root(&env, &leaf);

        // Tamper with the claimed price so the leaf no longer matches the root.
        let tampered_price: u128 = 101;
        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);

        let result = client.try_verify_price(
            &root,
            &asset_id,
            &tampered_price,
            &timestamp,
            &empty_proof,
            &60,
            &50,
            &150,
        );

        assert_eq!(result, Err(Ok(ConsumerError::InvalidProof)));
    }

    #[test]
    fn tampered_root_rejected() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 7);
        let price: u128 = 100;
        let timestamp: u64 = 990;
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (_root, proof) = single_leaf_root(&env, &leaf);
        let bad_root = BytesN::from_array(&env, &[0xff; 32]);

        let result = client.try_verify_price(
            &bad_root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(result, Err(Ok(ConsumerError::InvalidProof)));
    }

    #[test]
    fn invalid_bounds_rejected() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 8);
        let price: u128 = 100;
        let timestamp: u64 = 990;
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.try_verify_price(
            &root, &asset_id, &price, &timestamp, &proof, &60, &200, &100,
        );

        assert_eq!(result, Err(Ok(ConsumerError::InvalidBounds)));
    }

    #[test]
    fn disabled_freshness_and_bounds_succeed() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 9);
        let price: u128 = 42;
        let timestamp: u64 = 1; // very old, but max_age == 0 disables check
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.verify_price(
            &root,
            &asset_id,
            &price,
            &timestamp,
            &proof,
            &0,
            &0,
            &u128::MAX,
        );

        assert_eq!(
            result,
            VerifiedPrice {
                asset: asset_id,
                price,
                timestamp,
            }
        );
    }

    #[test]
    fn boundary_prices_accepted() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 10);
        let timestamp: u64 = 990;

        // Exactly at min bound.
        let price_min: u128 = 50;
        let leaf_min = merkle::price_leaf(&env, &asset_id, price_min, timestamp);
        let (root_min, proof_min) = single_leaf_root(&env, &leaf_min);
        let res_min = client.verify_price(
            &root_min, &asset_id, &price_min, &timestamp, &proof_min, &60, &50, &150,
        );
        assert_eq!(res_min.price, price_min);

        // Exactly at max bound.
        let price_max: u128 = 150;
        let leaf_max = merkle::price_leaf(&env, &asset_id, price_max, timestamp);
        let (root_max, proof_max) = single_leaf_root(&env, &leaf_max);
        let res_max = client.verify_price(
            &root_max, &asset_id, &price_max, &timestamp, &proof_max, &60, &50, &150,
        );
        assert_eq!(res_max.price, price_max);
    }

    #[test]
    fn boundary_age_accepted() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 11);
        let price: u128 = 100;
        let timestamp: u64 = 940; // exactly max_age == 60
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let result = client.verify_price(
            &root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(result.price, price);
    }

    #[test]
    fn verify_price_value_returns_price() {
        let (env, client) = setup();
        set_ledger_time(&env, 1_000);

        let asset_id = asset(&env, 12);
        let price: u128 = 123;
        let timestamp: u64 = 990;
        let leaf = merkle::price_leaf(&env, &asset_id, price, timestamp);
        let (root, proof) = single_leaf_root(&env, &leaf);

        let value = client.verify_price_value(
            &root, &asset_id, &price, &timestamp, &proof, &60, &50, &150,
        );

        assert_eq!(value, price);
    }
}