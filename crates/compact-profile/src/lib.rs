//! Capacity profiler for Midnight Compact contract transactions.
//!
//! A runner builds one unproven ledger transaction per scenario and lists them in a
//! [`manifest`]. [`tx`] re-costs each one with the ledger crate, [`limits`] evaluates the
//! per-transaction limits of a network [`profile`], [`block`] counts how many fit in a
//! block, [`series`] fits and bounds a size series, and [`snapshot`] pins the numbers so
//! a later run fails on drift. [`check`] ties these together for the CLI.

#![forbid(unsafe_code)]

pub mod block;
pub mod check;
pub mod cost;
pub mod fit;
pub mod limits;
pub mod manifest;
pub mod params;
pub mod profile;
pub mod report;
pub mod series;
pub mod snapshot;
pub mod tx;
pub mod version;
