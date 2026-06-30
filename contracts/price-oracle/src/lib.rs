#![no_std]

pub mod contract;
mod errors;
pub mod governance;
mod proxy;
pub mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod fuzz;
#[cfg(test)]
mod governance_test;
#[cfg(test)]
mod gas_benchmarks;

pub use contract::PriceOracleContract;
pub use governance::GovernanceContract;
pub use proxy::ProxyContract;
pub use types::{AssetPrice, PriceDataPoint};
