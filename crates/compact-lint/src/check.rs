//! The `check` subcommand: resolve the target, run the rules, add the format pass.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::config::Config;
use crate::diagnostic::{Badge, Diagnostic, FixPreview, Level};
use crate::edit::{apply, newline_of};
use crate::fix;
use crate::format::{self, FormatError};
use crate::report::RuleId;
use crate::rules::{LintError, Linter};
use crate::target::{self, TargetError};
use crate::timing::{Phase, Timings};

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
pub fn run(options: &Options, cwd: &Path, timings: &mut Timings) -> Result<Outcome, CheckError> {
    let walk = Phase::start("config and walk");
    let target = target::resolve(&options.paths, options.config_path.as_deref(), cwd)?;
    walk.stop(timings, format!("{} files matched", target.files.len()));

    let mut linter = Linter::new()?;
    let mut diagnostics = Vec::new();
    let mut parsing = Duration::ZERO;
    let mut previewing = Duration::ZERO;
    let mut issue_count = 0;
    let mut preview_count = 0;

    for path in &target.files {
        let started = Instant::now();
        let text = std::fs::read_to_string(path).map_err(|source| CheckError::Read {
            path: path.clone(),
            source,
        })?;
        let newline = newline_of(&text);
        let issues = linter.issues(path, &text, &target.config)?;
        parsing += started.elapsed();
        issue_count += issues.len();

        for issue in issues {
            let level = level_of(issue.rule(), &target.config, options.strict);
            let diagnostic = issue.diagnostic(path, level, &target.config);

            let started = Instant::now();
            let preview = fix::edit_for(&issue, &target.config, newline).map(|edit| {
                let after = apply(&text, std::slice::from_ref(&edit), newline);
                FixPreview::between(fix::title(&edit, Badge::Fixable), &text, &after)
            });
            previewing += started.elapsed();

            diagnostics.push(match preview {
                Some(preview) => {
                    preview_count += 1;
                    diagnostic.fixed_by(preview, Badge::Fixable)
                }
                None => diagnostic,
            });
        }
    }

    timings.record(
        "parse and rules",
        parsing,
        format!("{} files, {issue_count} issues", target.files.len()),
    );
    timings.record(
        "fix previews",
        previewing,
        format!("{preview_count} previews"),
    );

    let format_level = target.config.rules.get(RuleId::FORMAT);
    if options.no_format || format_level == Level::Off {
        timings.record("format check", Duration::ZERO, skipped(options.no_format));
    } else {
        let phase = Phase::start("format check");
        let found = format::check(&options.compact_bin, &target.files, format_level)?;
        phase.stop(
            timings,
            format!(
                "compact format --check, {} files, 1 process",
                target.files.len()
            ),
        );
        diagnostics.extend(found);
    }

    diagnostics.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
    Ok(Outcome {
        diagnostics,
        files_checked: target.files.len(),
    })
}

/// Why the format pass did not run, for its timing row.
fn skipped(no_format: bool) -> &'static str {
    if no_format {
        "skipped by --no-format"
    } else {
        "skipped by format = \"off\""
    }
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
