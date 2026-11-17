//! Doc-comment linter for Compact sources.
//!
//! The crate parses `.compact` files with the bundled tree-sitter grammar, matches each
//! declaration against the per-kind doc-comment template in `compact-lint.toml`, and
//! yields one [`rules::Issue`] per violation. `check` renders an issue as a
//! [`report::Finding`]; `fix` renders the repairable ones as an [`edit::Edit`].

#![forbid(unsafe_code)]

pub mod check;
pub mod config;
pub mod discover;
pub mod doc;
pub mod edit;
pub mod fix;
pub mod format;
pub mod model;
pub mod report;
pub mod rules;
pub mod target;
