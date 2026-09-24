//! Persistent scanner modules. Receipt projection is wallet-owned; allocation
//! journal and evidence snapshots are scanner-owned SQLite databases.
pub mod allocate;
pub mod allocation;
pub mod api;
pub mod cache;
pub mod config;
pub mod consensus;
pub mod daemon;
pub mod enhance;
pub mod lease;
pub mod private_fs;
pub mod projection;
pub mod receipt;
pub mod rpc;
pub mod scan;
pub(crate) mod snapshot;
pub mod wallet;
