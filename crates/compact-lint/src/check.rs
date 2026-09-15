//! The `check` subcommand: resolve the target, run the rules, add the format pass.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::Config;
use crate::diagnostic::{Badge, Diagnostic, FixPreview, Level};
use crate::edit::{apply, newline_of};
use crate::fix;
use crate::format::{self, FormatError};
use crate::report::RuleId;
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

/// The diagnostics, plus how many files produced them.
pub struct Outcome {
    pub diagnostics: Vec<Diagnostic>,
    pub files_checked: usize,
}

/// Runs the subcommand with `cwd` as the working directory.
/// # Errors
/// Returns an error when the config, the file walk, the parser or the formatter fails.
pub fn run(options: &Options, cwd: &Path) -> Result<Outcome, CheckError> {
    let target = target::resolve(&options.paths, options.config_path.as_deref(), cwd)?;

    let mut linter = Linter::new()?;
    let mut diagnostics = Vec::new();
    for path in &target.files {
        let text = std::fs::read_to_string(path).map_err(|source| CheckError::Read {
            path: path.clone(),
            source,
        })?;
        let newline = newline_of(&text);

        for issue in linter.issues(path, &text, &target.config)? {
            let level = level_of(issue.rule(), &target.config, options.strict);
            let diagnostic = issue.diagnostic(path, level, &target.config);

            diagnostics.push(match fix::edit_for(&issue, &target.config, newline) {
                Some(edit) => {
                    let after = apply(&text, std::slice::from_ref(&edit), newline);
                    let title = fix::title(&edit, Badge::Fixable);
                    diagnostic.fixed_by(FixPreview::between(title, &text, &after), Badge::Fixable)
                }
                None => diagnostic,
            });
        }
    }

    let format_level = target.config.rules.get(RuleId::FORMAT);
    if !options.no_format && format_level != Level::Off {
        diagnostics.extend(format::check(
            &options.compact_bin,
            &target.files,
            format_level,
        )?);
    }

    diagnostics.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
    Ok(Outcome {
        diagnostics,
        files_checked: target.files.len(),
    })
}

/// `--strict` promotes a placeholder to an error; a rule turned off stays off.
fn level_of(rule: RuleId, config: &Config, strict: bool) -> Level {
    let level = config.rules.get(rule);
    if strict && rule == RuleId::CONSTRAINTS_PLACEHOLDER && level != Level::Off {
        Level::Error
    } else {
        level
    }
}

#[cfg(test)]
mod tests {
    use super::level_of;
    use crate::config::Config;
    use crate::diagnostic::Level;
    use crate::report::RuleId;

    #[test]
    fn strict_promotes_a_placeholder_and_leaves_the_other_rules_alone() {
        let config = Config::default();

        assert_eq!(
            level_of(RuleId::CONSTRAINTS_PLACEHOLDER, &config, false),
            Level::Warn
        );
        assert_eq!(
            level_of(RuleId::CONSTRAINTS_PLACEHOLDER, &config, true),
            Level::Error
        );
        assert_eq!(level_of(RuleId::MISSING_DOC, &config, true), Level::Error);
    }

    #[test]
    fn strict_does_not_revive_a_placeholder_rule_turned_off() {
        let mut config = Config::default();
        config.rules.constraints_placeholder = Level::Off;

        assert_eq!(
            level_of(RuleId::CONSTRAINTS_PLACEHOLDER, &config, true),
            Level::Off
        );
    }
}
