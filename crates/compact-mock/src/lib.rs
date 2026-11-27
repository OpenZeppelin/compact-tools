//! Mock contract generator for Compact modules.
//!
//! [`config`] reads the `[mock]` table of `compact.toml`, and [`select`] finds the
//! modules its rules apply to. [`source`] parses a module with `compact-tree-sitter`, and
//! [`params`] splits its parameter lists and rewrites type text. [`scope`] resolves the
//! names a type uses across files. [`plan`] expands each module into mocks and decides
//! their circuits, imports, exports and constructor, and [`render`] emits the text.
//! [`own`] owns the artifacts directories through a stamp file, [`output`] writes, and
//! [`build`] compiles. [`coverage`] serves the linter. [`error`] holds every message.

#![forbid(unsafe_code)]

pub mod build;
pub mod config;
pub mod coverage;
pub mod error;
pub mod output;
pub mod own;
pub mod params;
pub mod plan;
pub mod render;
pub mod scope;
pub mod select;
pub mod source;
