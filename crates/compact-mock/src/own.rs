//! Ownership of artifacts directories through a stamp file.
//!
//! A directory is written only when the tool creates it, it is empty, or it holds
//! [`STAMP`], and a stamp counts only in an artifacts directory the config resolves
//! (`<module dir>/<test_dir>/artifacts`). Only `<dir>/<N>.compact` and `<dir>/<N>/` are
//! ever deleted, for a name `<N>` the stamp lists and the full expansion no longer
//! produces into `<dir>`, and only when the file carries the generated header and the
//! directory holds compiled output. A file the stamp does not list and without the header
//! is never overwritten. A symlink between `src` and an artifacts directory is an error.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

use crate::config::Paths;
use crate::error::OutputError;
use crate::output::{self, Target, Written};
use crate::params::is_name;
use crate::render::{MARKER, SPDX_PREFIX};

/// The entries `compact compile` writes into an output directory.
const COMPILED: [&str; 4] = ["compiler", "contract", "keys", "zkir"];

/// The file that marks a directory as the tool's.
pub const STAMP: &str = ".compact-mock-stamp";

const STAMP_HEADER: &str = "# compact-mock owns this directory. It deletes the mocks listed here once no rule produces them.";

/// The names a stamp lists. Comments, blank lines and non-identifiers are ignored.
#[must_use]
pub fn parse_stamp(text: &str) -> BTreeSet<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#') && is_name(line))
        .map(str::to_owned)
        .collect()
}

/// The stamp text for `names`: the header, then each name sorted by bytes.
#[must_use]
pub fn render_stamp(names: &BTreeSet<String>) -> String {
    let mut text = format!("{STAMP_HEADER}\n");
    for name in names {
        text.push_str(name);
        text.push('\n');
    }
    text
}

/// What is at an artifacts directory before a run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DirState {
    Missing,
    Empty,
    Stamped(BTreeSet<String>),
    /// Holds files but no stamp, or is not a plain directory.
    Foreign,
}

/// Inspects `dir` without following a symlink.
/// # Errors
/// Returns the error of a directory or stamp that cannot be read.
pub fn inspect(dir: &Path, paths: &Paths) -> Result<DirState, OutputError> {
    let read_error = |source| OutputError::Read {
        path: paths.show(dir),
        source,
    };
    let metadata = match std::fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(DirState::Missing),
        Err(error) => return Err(read_error(error)),
    };
    if !metadata.is_dir() {
        return Ok(DirState::Foreign);
    }
    let stamp = dir.join(STAMP);
    if std::fs::symlink_metadata(&stamp).is_ok_and(|meta| meta.is_file()) {
        let text = std::fs::read_to_string(&stamp).map_err(|source| OutputError::Read {
            path: paths.show(&stamp),
            source,
        })?;
        return Ok(DirState::Stamped(parse_stamp(&text)));
    }
    let mut listing = std::fs::read_dir(dir).map_err(read_error)?;
    Ok(if listing.next().is_none() {
        DirState::Empty
    } else {
        DirState::Foreign
    })
}

/// One directory the run touches.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DirPlan {
    pub dir: PathBuf,
    /// The stamp's names before the run.
    pub old: BTreeSet<String>,
    /// The names this run writes into it.
    pub written: BTreeSet<String>,
    /// The names the stamp lists after the run.
    pub last: BTreeSet<String>,
    /// Entries to delete, sorted by path.
    pub stale: Vec<PathBuf>,
}

/// The ownership plan of a run: every directory written or cleaned.
#[derive(Clone, Debug, Default)]
pub struct OwnPlan {
    pub dirs: Vec<DirPlan>,
    /// Information lines: stamps outside an artifacts directory, stale entries kept.
    pub notes: Vec<String>,
}

/// What a run produces, for the ownership plan.
pub struct Produced {
    /// `[mock].src`; symlinks below it are refused.
    pub src: PathBuf,
    /// `test_dir` after `{dir}/`, as segments; a stamp counts only in
    /// `<src>/.../<tail>/artifacts`.
    pub test_tail: Vec<String>,
    /// Directory → names this run writes.
    pub written: BTreeMap<PathBuf, BTreeSet<String>>,
    /// Directory → names the full expansion produces.
    pub expansion: BTreeMap<PathBuf, BTreeSet<String>>,
    /// Directories a failed module writes into: nothing is deleted there.
    pub unsure: BTreeSet<PathBuf>,
    /// Stamped directories under this root are examined for stale names; `None`
    /// disables deletion (NAME filtering).
    pub examine: Option<PathBuf>,
}

/// Checks ownership of every directory the run writes and computes the stale set.
/// Nothing on disk changes.
/// # Errors
/// Returns every directory the tool does not own, and read errors.
#[allow(
    clippy::too_many_lines,
    reason = "written directories, stamped directories, then stale entries, in order"
)]
pub fn plan(produced: &Produced, paths: &Paths) -> Result<OwnPlan, Vec<OutputError>> {
    let mut errors = Vec::new();
    let mut notes = Vec::new();
    let mut dirs: BTreeMap<PathBuf, DirPlan> = BTreeMap::new();
    for (dir, names) in &produced.written {
        if let Some(link) = linked_component(dir, &produced.src) {
            errors.push(OutputError::Symlink {
                path: paths.show(&link),
            });
            continue;
        }
        let old = match inspect(dir, paths) {
            Ok(DirState::Missing | DirState::Empty) => BTreeSet::new(),
            Ok(DirState::Stamped(old)) => old,
            Ok(DirState::Foreign) => {
                errors.push(OutputError::NotOwned {
                    dir: paths.show(dir),
                });
                continue;
            }
            Err(error) => {
                errors.push(error);
                continue;
            }
        };
        for name in names.iter().filter(|name| !old.contains(*name)) {
            let path = dir.join(format!("{name}.compact"));
            if std::fs::symlink_metadata(&path).is_ok() && !generated(&path) {
                errors.push(OutputError::NotGenerated {
                    path: paths.show(&path),
                });
            }
        }
        dirs.insert(
            dir.clone(),
            DirPlan {
                dir: dir.clone(),
                old,
                written: names.clone(),
                ..DirPlan::default()
            },
        );
    }
    if let Some(root) = &produced.examine {
        let mut stamped = Vec::new();
        stamped_dirs(root, &mut stamped);
        for dir in stamped {
            if !is_artifacts_dir(&dir, &produced.src, &produced.test_tail) {
                notes.push(format!(
                    "ignored {}: not an artifacts directory of this config",
                    paths.show(&dir.join(STAMP))
                ));
                continue;
            }
            if dirs.contains_key(&dir) {
                continue;
            }
            if let Ok(DirState::Stamped(old)) = inspect(&dir, paths) {
                dirs.insert(
                    dir.clone(),
                    DirPlan {
                        dir,
                        old,
                        ..DirPlan::default()
                    },
                );
            }
        }
    }
    for entry in dirs.values_mut() {
        let examined = produced
            .examine
            .as_ref()
            .is_some_and(|root| entry.dir.starts_with(root))
            && !produced.unsure.contains(&entry.dir);
        if !examined {
            entry.last = entry.old.union(&entry.written).cloned().collect();
            continue;
        }
        let expected: BTreeSet<String> = produced
            .expansion
            .get(&entry.dir)
            .into_iter()
            .flatten()
            .chain(&entry.written)
            .cloned()
            .collect();
        for name in entry.old.difference(&expected) {
            // On a case-insensitive disk the old spelling is the file just written.
            if expected.iter().any(|kept| kept.eq_ignore_ascii_case(name)) {
                continue;
            }
            let source = entry.dir.join(format!("{name}.compact"));
            match stale_kind(&source, false) {
                Stale::Absent => {}
                Stale::Owned => entry.stale.push(source),
                Stale::Kept(why) => notes.push(format!("kept {}: {why}", paths.show(&source))),
            }
            let compiled = entry.dir.join(name);
            match stale_kind(&compiled, true) {
                Stale::Absent => {}
                Stale::Owned => entry.stale.push(compiled),
                Stale::Kept(why) => notes.push(format!("kept {}: {why}", paths.show(&compiled))),
            }
        }
        entry.stale.sort();
        entry.last = expected;
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(OwnPlan {
        dirs: dirs
            .into_values()
            .filter(|entry| {
                !entry.written.is_empty() || !entry.stale.is_empty() || entry.last != entry.old
            })
            .collect(),
        notes,
    })
}

/// What a stale entry is.
enum Stale {
    Absent,
    /// A generated source or a compiled output directory: deleted.
    Owned,
    /// Anything else: kept, with the reason.
    Kept(&'static str),
}

fn stale_kind(path: &Path, directory: bool) -> Stale {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Stale::Absent;
    };
    if metadata.is_symlink() {
        return Stale::Kept("it is a symlink");
    }
    if directory {
        if metadata.is_dir() && compiled_output(path) {
            Stale::Owned
        } else {
            Stale::Kept("it is not compiled output")
        }
    } else if metadata.is_file() && generated(path) {
        Stale::Owned
    } else {
        Stale::Kept("it lacks the compact-mock header")
    }
}

/// Whether `path` is a regular file that opens with the generated header, after the SPDX
/// line when there is one.
#[must_use]
pub fn generated(path: &Path) -> bool {
    if !std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()) {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = io::BufReader::new(file);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return false;
    }
    if line.starts_with(SPDX_PREFIX) {
        line.clear();
        if reader.read_line(&mut line).is_err() {
            return false;
        }
    }
    line.starts_with(MARKER)
}

/// Whether every entry of `dir` is a directory `compact compile` writes.
fn compiled_output(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|listing| {
        listing.filter_map(Result::ok).all(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && COMPILED.iter().any(|name| entry.file_name() == *name)
        })
    })
}

/// Whether `dir` is `<src>/<module dir>/<tail>/artifacts`.
fn is_artifacts_dir(dir: &Path, src: &Path, tail: &[String]) -> bool {
    let Ok(rest) = dir.strip_prefix(src) else {
        return false;
    };
    let segments: Vec<String> = rest
        .iter()
        .map(|segment| segment.to_string_lossy().into_owned())
        .collect();
    match segments.split_last() {
        Some((last, parents)) => last == "artifacts" && !tail.is_empty() && parents.ends_with(tail),
        None => false,
    }
}

/// The first symlink on the way from `src` (exclusive) down to `dir` (inclusive), if any.
#[must_use]
pub fn linked_component(dir: &Path, src: &Path) -> Option<PathBuf> {
    let rest = dir.strip_prefix(src).ok()?;
    let mut current = src.to_owned();
    for segment in rest {
        current.push(segment);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_symlink() => return Some(current),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
}

/// Every stamped directory under `root`, without following symlinks.
fn stamped_dirs(root: &Path, found: &mut Vec<PathBuf>) {
    let Ok(metadata) = std::fs::symlink_metadata(root) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    if std::fs::symlink_metadata(root.join(STAMP)).is_ok_and(|meta| meta.is_file()) {
        found.push(root.to_owned());
    }
    let Ok(listing) = std::fs::read_dir(root) else {
        return;
    };
    let mut children: Vec<PathBuf> = listing
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| entry.file_name() != "node_modules")
        .map(|entry| entry.path())
        .collect();
    children.sort();
    for child in children {
        stamped_dirs(&child, found);
    }
}

/// The step a run just finished, for fault injection in tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    StampsWidened,
    SourcesWritten,
    StaleRemoved,
}

/// What a run did, in print order.
#[derive(Clone, Debug, Default)]
pub struct Report {
    /// Each target with what happened to it, in expansion order.
    pub targets: Vec<(String, Written)>,
    /// Each deleted entry, in path order.
    pub removed: Vec<String>,
}

/// Applies an ownership plan and writes the targets, in crash-safe order: widen each
/// stamp, write sources, delete stale entries, narrow each stamp. `hook` runs after each
/// of the first three steps; an error from it stops the run there.
/// # Errors
/// Returns the first IO error.
pub fn execute(
    plan: &OwnPlan,
    targets: &[Target],
    paths: &Paths,
    hook: &mut dyn FnMut(Step) -> io::Result<()>,
) -> Result<Report, OutputError> {
    let write_stamp = |dir: &Path, names: &BTreeSet<String>| {
        let path = dir.join(STAMP);
        output::replace(&path, render_stamp(names).as_bytes()).map_err(|source| {
            OutputError::Write {
                path: paths.show(&path),
                source,
            }
        })
    };
    let hooked = |step: Step, hook: &mut dyn FnMut(Step) -> io::Result<()>| {
        hook(step).map_err(|source| OutputError::Write {
            path: format!("{step:?}"),
            source,
        })
    };

    for entry in &plan.dirs {
        if !entry.written.is_empty() || entry.old != entry.last {
            let widened: BTreeSet<String> = entry.old.union(&entry.written).cloned().collect();
            if widened != entry.old || !entry.dir.join(STAMP).exists() {
                write_stamp(&entry.dir, &widened)?;
            }
        }
    }
    hooked(Step::StampsWidened, hook)?;

    let mut report = Report::default();
    for target in targets {
        report
            .targets
            .push((target.shown.clone(), output::write(target)?));
    }
    hooked(Step::SourcesWritten, hook)?;

    let mut removed: Vec<&PathBuf> = plan.dirs.iter().flat_map(|entry| &entry.stale).collect();
    removed.sort();
    for path in removed {
        remove(path).map_err(|source| OutputError::Remove {
            path: paths.show(path),
            source,
        })?;
        report.removed.push(paths.show(path));
    }
    hooked(Step::StaleRemoved, hook)?;

    for entry in &plan.dirs {
        if entry.last.is_empty() && only_stamp(&entry.dir) {
            let stamp = entry.dir.join(STAMP);
            std::fs::remove_file(&stamp)
                .and_then(|()| std::fs::remove_dir(&entry.dir))
                .map_err(|source| OutputError::Remove {
                    path: paths.show(&entry.dir),
                    source,
                })?;
            continue;
        }
        let current = std::fs::read_to_string(entry.dir.join(STAMP)).unwrap_or_default();
        if current != render_stamp(&entry.last) {
            write_stamp(&entry.dir, &entry.last)?;
        }
    }
    Ok(report)
}

/// Removes a file or symlink as itself, or a real directory with its contents.
fn remove(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// Whether `dir` holds nothing but the stamp.
fn only_stamp(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|listing| {
        listing
            .filter_map(Result::ok)
            .all(|entry| entry.file_name() == STAMP)
    })
}

#[cfg(test)]
mod tests;
