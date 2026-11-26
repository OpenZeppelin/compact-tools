//! Mock contract generator for Compact modules.
//!
//! [`config`] reads `compact-mock.toml`. [`source`] parses a module with
//! `compact-tree-sitter`, and [`params`] splits its parameter lists and rewrites type
//! text. [`scope`] resolves the names a type uses across files. [`plan`] decides each
//! mock's circuits, imports, exports and constructor, [`render`] emits the text, and
//! [`output`] owns, writes and checks the files. [`error`] holds every message.

#![forbid(unsafe_code)]

pub mod config;
pub mod error;
pub mod output;
pub mod params;
pub mod plan;
pub mod render;
pub mod scope;
pub mod source;
