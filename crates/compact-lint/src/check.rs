//! The `check` subcommand: resolve config, collect files, run the rules.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::{Config, ConfigError, discover as discover_config};
use crate::discover::{self, DiscoverError};
use crate::format::{self, FormatError};
use crate::report::Finding;
use crate::rules::{LintError, Linter};

#[derive(Debug, Error)]
pub enum CheckError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Discover(#[from] DiscoverError),
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
    let (config, config_path, base) = resolve_config(options, cwd)?;
    let source = config_path.as_deref().unwrap_or(Path::new("<defaults>"));

    let exclude = config.exclude_set(source)?;
    let files = if options.paths.is_empty() {
        let include = config.include_set(source)?;
        discover::from_globs(&base, &include, &exclude)?
    } else {
        let paths = absolute_paths(&options.paths, cwd);
        discover::from_paths(&paths, &base, &exclude)?
    };
    let files: Vec<PathBuf> = files.iter().map(|path| display_path(path, cwd)).collect();

    let mut linter = Linter::new()?;
    let mut findings = Vec::new();
    for path in &files {
        let text = std::fs::read_to_string(path).map_err(|source| CheckError::Read {
            path: path.clone(),
            source,
        })?;
        findings.extend(linter.check(path, &text, &config, options.strict)?);
    }

    if !options.no_format {
        findings.extend(format::check(&options.compact_bin, &files)?);
    }

    findings.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
    Ok(Outcome {
        findings,
        files_checked: files.len(),
    })
}

/// An explicit `--config` is a shareable preset, so glob discovery stays anchored at
/// `cwd`; a config found by walking upward anchors discovery at its own directory.
fn resolve_config(
    options: &Options,
    cwd: &Path,
) -> Result<(Config, Option<PathBuf>, PathBuf), ConfigError> {
    if let Some(path) = options.config_path.as_deref() {
        return Ok((Config::load(path)?, Some(path.to_owned()), cwd.to_owned()));
    }

    match discover_config(cwd) {
        Some(path) => {
            let base = path.parent().unwrap_or(cwd).to_owned();
            Ok((Config::load(&path)?, Some(path), base))
        }
        None => Ok((Config::default(), None, cwd.to_owned())),
    }
}

/// Discovery matches the exclude globs against paths relative to the config's
/// directory, so a CLI path has to be anchored at `cwd` first: a bare `archive`
/// given from a subdirectory would otherwise never match `contracts/archive/**`.
fn absolute_paths(paths: &[PathBuf], cwd: &Path) -> Vec<PathBuf> {
    paths
        .iter()
        .map(|path| {
            if path.is_absolute() {
                path.clone()
            } else {
                cwd.join(path)
            }
        })
        .collect()
}

/// Paths under the working directory print relative to it; anything else prints as is.
fn display_path(path: &Path, cwd: &Path) -> PathBuf {
    path.strip_prefix(cwd).unwrap_or(path).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_is_anchored_at_the_working_directory() {
        let resolved = absolute_paths(&[PathBuf::from("archive")], Path::new("/repo/contracts"));

        assert_eq!(resolved, vec![PathBuf::from("/repo/contracts/archive")]);
    }

    #[test]
    fn an_absolute_path_is_left_alone() {
        let resolved = absolute_paths(&[PathBuf::from("/elsewhere/X.compact")], Path::new("/repo"));

        assert_eq!(resolved, vec![PathBuf::from("/elsewhere/X.compact")]);
    }
}
