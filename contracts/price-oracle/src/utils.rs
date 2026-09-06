// Issue #298 — Shared helpers used by both PriceOracleContract (contract/) and
// ProxyContract (proxy.rs).  Previously duplicated in each file with subtle
// drift (e.g. two different USD-conversion formulas); a single implementation
// here keeps behavior identical across both entry points.
//
// All helpers are pure with respect to storage except where noted.

use soroban_sdk::{Address, Env, String, Vec};

use crate::storage;
use crate::types::{PriceDataPoint, SourceReputation};

// Basis points threshold below which a submission is counted as accurate for reputation.
pub const REPUTATION_ACCURACY_THRESHOLD_BPS: u128 = 2000; // 20%
// Seconds between reputation decay applications (~7 days).
pub const REPUTATION_DECAY_PERIOD_SECS: u64 = 604_800;
// Decay factor per period: score = score * 95 / 100.
pub const REPUTATION_DECAY_NUMERATOR: u32 = 95;
pub const REPUTATION_DECAY_DENOMINATOR: u32 = 100;

// ── History ──────────────────────────────────────────────────────────────────

/// Append a data point to an asset's price history, capping it at
/// storage::MAX_HISTORY_LEN to keep the persistent-storage entry size bounded.
pub fn append_history(env: &Env, asset: &String, data_point: PriceDataPoint) {
    let mut history = storage::get_price_history(env, asset);
    if history.len() >= storage::MAX_HISTORY_LEN {
        // Drop the oldest entry (index 0) by rebuilding from index 1.
        // Soroban Vec has no remove(), so we shift manually.
        let mut trimmed: Vec<PriceDataPoint> = Vec::new(env);
        for i in 1..history.len() {
            if let Some(dp) = history.get(i) {
                trimmed.push_back(dp);
            }
        }
        trimmed.push_back(data_point);
        storage::set_price_history(env, asset, &trimmed);
    } else {
        history.push_back(data_point);
        storage::set_price_history(env, asset, &history);
    }
}

// ── Issue #69 — deviation helper ─────────────────────────────────────────────

/// Returns true when the new price deviates from prev_price by more than
/// threshold_bps.  Uses u128 arithmetic throughout to avoid i128 overflow
/// under any input.
pub fn deviation_exceeds(new_price: i128, prev_price: i128, threshold_bps: u32) -> bool {
    if prev_price == 0 {
        return false;
    }
    let prev_abs = prev_price.unsigned_abs();

    let diff: u128 = if (new_price >= 0) == (prev_price >= 0) {
        let new_abs = new_price.unsigned_abs();
        if new_abs >= prev_abs {
            new_abs - prev_abs
        } else {
            prev_abs - new_abs
        }
    } else {
        new_price.unsigned_abs().saturating_add(prev_abs)
    };

    let deviation_bps = diff.saturating_mul(10_000) / prev_abs;
    deviation_bps > threshold_bps as u128
}

// ── Issue #70 — reputation helpers ───────────────────────────────────────────

pub fn update_reputation(
    env: &Env,
    source: &Address,
    new_price: i128,
    asset: &String,
    timestamp: u64,
) {
    let is_accurate = match storage::get_latest_price(env, asset) {
        None => true,
        Some(prev) => {
            !deviation_exceeds(new_price, prev.price, REPUTATION_ACCURACY_THRESHOLD_BPS as u32)
        }
    };

    let mut rep = storage::get_source_reputation(env, source).unwrap_or(SourceReputation {
        score: 10_000,
        total_submissions: 0,
        accurate_submissions: 0,
        last_updated: timestamp,
    });

    rep.total_submissions = rep.total_submissions.saturating_add(1);
    if is_accurate {
        rep.accurate_submissions = rep.accurate_submissions.saturating_add(1);
    }
    rep.score = if rep.total_submissions == 0 {
        10_000
    } else {
        (rep.accurate_submissions as u32)
            .saturating_mul(10_000)
            / rep.total_submissions
    };
    rep.last_updated = timestamp;

    storage::set_source_reputation(env, source, &rep);
}

pub fn apply_reputation_decay(env: &Env, mut rep: SourceReputation) -> SourceReputation {
    let now = env.ledger().timestamp();
    let elapsed = now.saturating_sub(rep.last_updated);
    if elapsed < REPUTATION_DECAY_PERIOD_SECS {
        return rep;
    }
    let periods = (elapsed / REPUTATION_DECAY_PERIOD_SECS).min(40) as u32;
    for _ in 0..periods {
        rep.score = rep
            .score
            .saturating_mul(REPUTATION_DECAY_NUMERATOR)
            / REPUTATION_DECAY_DENOMINATOR;
    }
    rep
}

// ── USD conversion ───────────────────────────────────────────────────────────

/// Convert a stored price into its USD value.
///
/// Convention (unchanged from the original oracle design):
///   - XLM prices are already denominated in USD terms and are returned as-is.
///   - USDC is a 1:1 USD peg; one USDC unit equals 10^decimals.
///   - Every other asset is quoted in XLM on-chain, so its USD value is
///     `(price * xlm_price) / 10^(decimals + xlm_decimals)`.
///
/// All arithmetic is checked; on overflow (e.g. pathological decimal counts)
/// the conversion returns `None` instead of panicking, so reads stay safe.
pub fn calculate_usd_price(env: &Env, asset: &String, price: i128, decimals: u32) -> Option<i128> {
    let xlm = String::from_str(env, "XLM");
    if asset == &xlm {
        return Some(price);
    }

    let usdc = String::from_str(env, "USDC");
    if asset == &usdc {
        return 10i128.checked_pow(decimals);
    }

    let xlm_price = storage::get_latest_price(env, &xlm)?;
    let scale = decimals.saturating_add(xlm_price.decimals);
    let divisor = 10i128.checked_pow(scale)?;
    price.checked_mul(xlm_price.price)?.checked_div(divisor)
}

// ── Address collections ──────────────────────────────────────────────────────

pub fn vec_contains_address(vec: &Vec<Address>, target: &Address) -> bool {
    for i in 0..vec.len() {
        if let Some(addr) = vec.get(i) {
            if &addr == target {
                return true;
            }
        }
    }
    false
}
