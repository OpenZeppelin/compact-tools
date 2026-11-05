//! Doc-comment linter for Compact sources.
//!
//! The crate parses `.compact` files with the bundled tree-sitter grammar, matches each
//! declaration against the per-kind doc-comment template in `compact-lint.toml`, and
//! reports one [`report::Finding`] per violation.

#![forbid(unsafe_code)]

pub mod check;
pub mod config;
pub mod discover;
pub mod doc;
pub mod format;
pub mod model;
pub mod report;
pub mod rules;
