#![no_std]

pub mod contract;
mod errors;
mod proxy;
pub mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod fuzz;

pub use contract::PriceOracleContract;
pub use proxy::ProxyContract;
pub use types::{AssetPrice, PriceDataPoint};
