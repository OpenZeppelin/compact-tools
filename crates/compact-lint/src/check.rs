//! The `check` subcommand: resolve the target, run the rules, add the format pass.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::format::{self, FormatError};
use crate::report::Finding;
use crate::rules::{LintError, Linter};
use crate::target::{self, TargetError};

#[derive(Debug, Error)]
pub enum CheckError {
    #[error(transparent)]
    Target(#[from] TargetError),
    #[error(transparent)]
    Lint(#[from] LintError),
    #[error(transparent)]
    Format(#[from] FormatError),
    #[error("cannot read {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Everything the `check` subcommand needs, already resolved from flags and env.
pub struct Options {
    pub paths: Vec<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub strict: bool,
    pub no_format: bool,
    pub compact_bin: OsString,
}

/// The findings, plus how many files produced them.
pub struct Outcome {
    pub findings: Vec<Finding>,
    pub files_checked: usize,
}

impl Outcome {
    #[must_use]
    pub fn summary(&self) -> String {
        format!(
            "{} findings in {} files",
            self.findings.len(),
            self.files_checked
        )
    }
}

/// Runs the subcommand with `cwd` as the working directory.
/// # Errors
/// Returns an error when the config, the file walk, the parser or the formatter fails.
pub fn run(options: &Options, cwd: &Path) -> Result<Outcome, CheckError> {
    let target = target::resolve(&options.paths, options.config_path.as_deref(), cwd)?;

    let mut linter = Linter::new()?;
    let mut findings = Vec::new();
    for path in &target.files {
        let text = std::fs::read_to_string(path).map_err(|source| CheckError::Read {
            path: path.clone(),
            source,
        })?;
        findings.extend(linter.check(path, &text, &target.config, options.strict)?);
    }

    if !options.no_format {
        findings.extend(format::check(&options.compact_bin, &target.files)?);
    }

    findings.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
    Ok(Outcome {
        findings,
        files_checked: target.files.len(),
    })
}
