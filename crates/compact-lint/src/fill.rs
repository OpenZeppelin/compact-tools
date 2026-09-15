//! The `fill-constraints` subcommand: measure every tagged circuit and write the value in.
//!
//! Scope is the constraints annotations that already exist. A circuit with no annotation
//! is `fix`'s job, so this pass never adds one.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::ConfigError;
use crate::edit::{DocOp, Edit, EditKind, WriteError, apply, newline_of, write_atomically};
use crate::measure::{self, Compiler, Constraints, MeasureError};
use crate::report::Position;
use crate::rules::{ConstraintSite, LintError, Linter};
use crate::source::{Resolver, Source};
use crate::target::{self, TargetError};

/// The rule name for a tagged circuit its source does not measure.
const UNMEASURED: &str = "constraints-unmeasured";

/// The rule name for a file with no measurement source at all.
const UNMEASURABLE: &str = "constraints-unmeasurable";

#[derive(Debug, Error)]
pub enum FillError {
    #[error(transparent)]
    Target(#[from] TargetError),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Lint(#[from] LintError),
    #[error(transparent)]
    Measure(#[from] MeasureError),
    #[error(transparent)]
    Write(#[from] WriteError),
    #[error("cannot read {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Everything the subcommand needs, already resolved from flags and env.
pub struct Options {
    pub paths: Vec<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub dry_run: bool,
    /// Read the `.circuit-info.json` caches instead of compiling.
    pub no_compile: bool,
    pub compact_bin: OsString,
    /// Where the compiler writes; a run without one uses a temporary directory.
    pub artifacts: PathBuf,
}

/// The report lines and the counts behind the summary.
pub struct Outcome {
    /// One line per change or gap, in file order.
    pub lines: Vec<String>,
    pub filled: usize,
    pub files: usize,
    pub unmeasured: usize,
}

impl Outcome {
    #[must_use]
    pub fn summary(&self) -> String {
        format!(
            "{} values filled in {} files, {} unmeasured",
            self.filled, self.files, self.unmeasured
        )
    }
}

/// One file's annotations and the contract they are measured through.
struct Work {
    path: PathBuf,
    text: String,
    sites: Vec<ConstraintSite>,
    source: Source,
}

/// Runs the subcommand with `cwd` as the working directory.
/// # Errors
/// Returns an error when the config, the file walk, the parser, the compiler or a write
/// fails.
pub fn run(options: &Options, cwd: &Path) -> Result<Outcome, FillError> {
    let target = target::resolve(&options.paths, options.config_path.as_deref(), cwd)?;
    let resolver = Resolver::new(&target.config, &target.base, cwd)?;
    let tag = target.config.constraints.tag.clone();

    let mut linter = Linter::new()?;
    let mut work = Vec::new();
    for path in &target.files {
        let text = std::fs::read_to_string(path).map_err(|source| FillError::Read {
            path: path.clone(),
            source,
        })?;
        let sites = linter.constraint_sites(path, &text, &target.config)?;
        if sites.is_empty() {
            continue;
        }
        let source = resolver.resolve(path);
        work.push(Work {
            path: path.clone(),
            text,
            sites,
            source,
        });
    }

    let measured = measure_sources(
        &work,
        options,
        target.config.constraints.compiler.as_ref(),
        cwd,
    )?;

    let mut outcome = Outcome {
        lines: Vec::new(),
        filled: 0,
        files: 0,
        unmeasured: 0,
    };
    for file in &work {
        fill_file(file, &measured, &tag, options, &mut outcome)?;
    }
    Ok(outcome)
}

/// Compiles each distinct source once, or reads its cache under `--no-compile`.
fn measure_sources(
    work: &[Work],
    options: &Options,
    version: Option<&String>,
    cwd: &Path,
) -> Result<BTreeMap<PathBuf, BTreeMap<String, Constraints>>, FillError> {
    let mut sources: Vec<&PathBuf> = work
        .iter()
        .filter_map(|file| match &file.source {
            Source::Found(source) => Some(source),
            Source::Missing(_) => None,
        })
        .collect();
    sources.sort();
    sources.dedup();

    let compiler = Compiler {
        binary: options.compact_bin.clone(),
        version: version.cloned(),
        artifacts: options.artifacts.clone(),
        cwd: cwd.to_owned(),
    };

    let mut measured = BTreeMap::new();
    for source in sources {
        let list = if options.no_compile {
            measure::read_cache(source)?.ok_or_else(|| MeasureError::CacheMiss {
                path: measure::cache_path(source),
                name: source.display().to_string(),
            })?
        } else {
            let list = compiler.measure(source)?;
            // A preview writes nothing, the cache included.
            if !options.dry_run {
                measure::write_cache(source, &list)?;
            }
            list
        };

        measured.insert(
            source.clone(),
            list.iter()
                .map(|entry| (entry.name.clone(), entry.constraints()))
                .collect(),
        );
    }
    Ok(measured)
}

/// Rewrites one file's annotations and records what changed and what could not be measured.
fn fill_file(
    file: &Work,
    measured: &BTreeMap<PathBuf, BTreeMap<String, Constraints>>,
    tag: &crate::doc::Tag,
    options: &Options,
    outcome: &mut Outcome,
) -> Result<(), FillError> {
    let source = match &file.source {
        Source::Found(source) => source,
        Source::Missing(tried) => {
            outcome.lines.push(unmeasurable_line(&file.path, tried));
            outcome.unmeasured += file.sites.len();
            return Ok(());
        }
    };
    let constraints = measured.get(source);

    let mut edits = Vec::new();
    for site in &file.sites {
        let Some(measurement) = constraints.and_then(|found| found.get(&site.circuit)) else {
            outcome
                .lines
                .push(unmeasured_line(&file.path, site, source));
            outcome.unmeasured += 1;
            continue;
        };

        let value = measurement.value();
        if value == site.value {
            continue;
        }

        outcome.lines.push(format!(
            "{}: fill: {tag} {} -> {value}",
            at(&file.path, site.position),
            site.value
        ));
        edits.push(Edit {
            position: site.position,
            message: String::new(),
            kind: EditKind::Doc {
                range: site.doc.range.clone(),
                indent: site.doc.indent,
                op: DocOp::SetTagValue {
                    line: site.line_offset,
                    tag: tag.to_string(),
                    value,
                },
            },
        });
    }

    if edits.is_empty() {
        return Ok(());
    }

    outcome.filled += edits.len();
    outcome.files += 1;
    if !options.dry_run {
        let newline = newline_of(&file.text);
        write_atomically(&file.path, &apply(&file.text, &edits, newline))?;
    }
    Ok(())
}

fn unmeasured_line(path: &Path, site: &ConstraintSite, source: &Path) -> String {
    format!(
        "{}: {UNMEASURED}: circuit `{}` has no measurement in {}",
        at(path, site.position),
        site.circuit,
        source.display()
    )
}

fn unmeasurable_line(path: &Path, tried: &[PathBuf]) -> String {
    let tried: Vec<String> = tried
        .iter()
        .map(|path| path.display().to_string())
        .collect();
    format!(
        "{}: {UNMEASURABLE}: no measurement source for {}; tried {}",
        at(path, Position::file_start()),
        path.display(),
        if tried.is_empty() {
            "nothing".to_owned()
        } else {
            tried.join(", ")
        }
    )
}

fn at(path: &Path, position: Position) -> String {
    format!("{}:{}:{}", path.display(), position.line, position.column)
}

#[cfg(test)]
mod tests {
    use super::Outcome;

    #[test]
    fn the_summary_counts_values_files_and_gaps() {
        let outcome = Outcome {
            lines: Vec::new(),
            filled: 12,
            files: 4,
            unmeasured: 1,
        };

        assert_eq!(
            outcome.summary(),
            "12 values filled in 4 files, 1 unmeasured"
        );
    }
}
