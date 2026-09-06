#![cfg_attr(not(test), no_std)]

pub mod contract;
mod errors;
mod governance;
mod merkle;
mod multisig;
mod proxy;
pub mod storage;
mod types;
mod utils;

#[cfg(test)]
mod test;
#[cfg(test)]
mod fuzz;
#[cfg(test)]
mod governance_test;
#[cfg(test)]
mod merkle_test;
#[cfg(test)]
mod proxy_test;
#[cfg(test)]
mod gas_benchmarks;
#[cfg(test)]
mod upgrade_migration_test;

pub use contract::PriceOracleContract;
pub use governance::GovernanceContract;
pub use multisig::MultiSigAdminContract;
pub use proxy::ProxyContract;
pub use types::{AssetPrice, HybridSignature, PostQuantumAdminKey, PostQuantumScheme, PriceDataPoint};
