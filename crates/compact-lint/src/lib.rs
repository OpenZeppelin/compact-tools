//! Doc-comment linter for Compact sources.
//!
//! The crate parses `.compact` files with the bundled tree-sitter grammar, matches each
//! declaration against the per-kind doc-comment template in `compact.toml`'s `[lint]`
//! table, and yields one [`rules::Issue`] per violation. `check` renders an issue as a
//! [`diagnostic::Diagnostic`]; `fix` renders the repairable ones as an [`edit::Edit`].
//! `fill-constraints` takes the other path: [`measure`] compiles a contract and
//! [`fill`] writes the measured values into the annotations that already exist.

#![forbid(unsafe_code)]

pub mod check;
pub mod config;
pub mod diagnostic;
pub mod discover;
pub mod doc;
pub mod edit;
pub mod fill;
pub mod fix;
pub mod format;
pub mod measure;
pub mod model;
pub mod report;
pub mod rules;
pub mod source;
pub mod target;
pub mod timing;
