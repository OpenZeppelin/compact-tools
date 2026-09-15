//! The `fill-constraints` subcommand: measure every tagged circuit and write the value in.
//!
//! Scope is the constraints annotations that already exist. A circuit with no annotation
//! is `fix`'s job, so this pass never adds one.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::{Config, ConfigError};
use crate::diagnostic::{Badge, Diagnostic, FixPreview, Level, Span};
use crate::edit::{DocOp, Edit, EditKind, WriteError, apply, newline_of, write_atomically};
use crate::measure::{self, Compiler, Constraints, MeasureError};
use crate::report::{Position, RuleId};
use crate::rules::{ConstraintSite, LintError, Linter};
use crate::source::{Resolver, Source};
use crate::target::{self, TargetError};

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

/// The diagnostics and the counts behind the summary.
pub struct Outcome {
    pub diagnostics: Vec<Diagnostic>,
    pub filled: usize,
    /// Files that took a value.
    pub files: usize,
    /// Files the run read, changed or not.
    pub checked: usize,
    pub unmeasured: usize,
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
        diagnostics: Vec::new(),
        filled: 0,
        files: 0,
        checked: target.files.len(),
        unmeasured: 0,
    };
    for file in &work {
        fill_file(file, &measured, &tag, &target.config, options, &mut outcome)?;
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
    config: &Config,
    options: &Options,
    outcome: &mut Outcome,
) -> Result<(), FillError> {
    let badge = if options.dry_run {
        Badge::Fixable
    } else {
        Badge::Fixed
    };
    let newline = newline_of(&file.text);

    let source = match &file.source {
        Source::Found(source) => source,
        Source::Missing(tried) => {
            let level = config.rules.get(RuleId::CONSTRAINTS_UNMEASURABLE);
            if level != Level::Off {
                outcome
                    .diagnostics
                    .push(unmeasurable(&file.path, tried, level));
                outcome.unmeasured += file.sites.len();
            }
            return Ok(());
        }
    };
    let constraints = measured.get(source);
    let unmeasured_level = config.rules.get(RuleId::CONSTRAINTS_UNMEASURED);

    let mut edits = Vec::new();
    for site in &file.sites {
        let Some(measurement) = constraints.and_then(|found| found.get(&site.circuit)) else {
            if unmeasured_level != Level::Off {
                outcome.diagnostics.push(unmeasured(
                    &file.path,
                    site,
                    source,
                    tag,
                    unmeasured_level,
                ));
                outcome.unmeasured += 1;
            }
            continue;
        };

        let value = measurement.value();
        if value == site.value {
            continue;
        }

        let edit = Edit {
            span: Span::columns(site.position, tag.as_str().len()),
            rule: RuleId::FILL,
            message: format!("set {tag} to {value}"),
            kind: EditKind::Doc {
                range: site.doc.range.clone(),
                indent: site.doc.indent,
                op: DocOp::SetTagValue {
                    line: site.line_offset,
                    tag: tag.to_string(),
                    value,
                },
            },
        };

        let after = apply(&file.text, std::slice::from_ref(&edit), newline);
        let title = crate::fix::title(&edit, badge);
        outcome.diagnostics.push(
            Diagnostic::new(
                file.path.clone(),
                RuleId::FILL,
                Level::Info,
                format!(
                    "Circuit `{}` measures {}.",
                    site.circuit,
                    measurement.value()
                ),
            )
            .at(edit.span)
            .fixed_by(FixPreview::between(title, &file.text, &after), badge),
        );
        edits.push(edit);
    }

    if edits.is_empty() {
        return Ok(());
    }

    outcome.filled += edits.len();
    outcome.files += 1;
    if !options.dry_run {
        write_atomically(&file.path, &apply(&file.text, &edits, newline))?;
    }
    Ok(())
}

/// A tagged circuit whose source compiled but produced no measurement for its name.
fn unmeasured(
    path: &Path,
    site: &ConstraintSite,
    source: &Path,
    tag: &crate::doc::Tag,
    level: Level,
) -> Diagnostic {
    Diagnostic::new(
        path,
        RuleId::CONSTRAINTS_UNMEASURED,
        level,
        format!("Circuit `{}` has no measurement.", site.circuit),
    )
    .at(Span::columns(site.position, tag.as_str().len()))
    .advise(format!(
        "It is measured through {}, which exports no circuit of that name.",
        source.display()
    ))
}

/// A file no template, glob or override resolves a measurement source for.
fn unmeasurable(path: &Path, tried: &[PathBuf], level: Level) -> Diagnostic {
    let tried: Vec<String> = tried
        .iter()
        .map(|path| path.display().to_string())
        .collect();

    Diagnostic::new(
        path,
        RuleId::CONSTRAINTS_UNMEASURABLE,
        level,
        format!("No measurement source for {}.", path.display()),
    )
    .at(Span::columns(Position::file_start(), 1))
    .advise(format!(
        "Tried {}; add one, or name it in constraints.overrides.",
        if tried.is_empty() {
            "nothing".to_owned()
        } else {
            tried.join(", ")
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::{Position, unmeasurable, unmeasured};
    use crate::diagnostic::Level;
    use crate::doc::Tag;
    use crate::rules::{ConstraintSite, DocRef};
    use std::path::{Path, PathBuf};

    #[test]
    fn an_unmeasured_circuit_names_the_source_in_its_advice() {
        let site = ConstraintSite {
            circuit: "initialize".to_owned(),
            position: Position {
                line: 30,
                column: 6,
            },
            line_offset: 2,
            value: "k=?, rows=?".to_owned(),
            doc: DocRef {
                range: 0..1,
                indent: 2,
            },
        };

        let diagnostic = unmeasured(
            Path::new("src/access/Ownable.compact"),
            &site,
            Path::new("src/access/test/mocks/MockOwnable.compact"),
            &Tag::new("@constraints"),
            Level::Warn,
        );

        assert_eq!(
            diagnostic.message,
            "Circuit `initialize` has no measurement."
        );
        assert!(
            diagnostic.advice[0].contains("MockOwnable.compact"),
            "{:?}",
            diagnostic.advice
        );
    }

    #[test]
    fn an_unmeasurable_file_lists_every_candidate_it_tried() {
        let diagnostic = unmeasurable(
            Path::new("src/orphan/Orphan.compact"),
            &[PathBuf::from("a.compact"), PathBuf::from("b.compact")],
            Level::Warn,
        );

        assert_eq!(
            diagnostic.advice[0],
            "Tried a.compact, b.compact; add one, or name it in constraints.overrides."
        );
    }
}
