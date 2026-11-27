//! Ownership of artifacts directories through a stamp file.
//!
//! A directory is written only when the tool creates it, it is empty, or it holds
//! [`STAMP`]. Only `<dir>/<N>.compact` and `<dir>/<N>/` are ever deleted, for a name `<N>`
//! the stamp lists and the full expansion no longer produces into `<dir>`. Symlinks are
//! never followed.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

use crate::config::Paths;
use crate::error::OutputError;
use crate::output::{self, Target, Written};
use crate::params::is_name;

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
}

/// What a run produces, for the ownership plan.
pub struct Produced {
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
pub fn plan(produced: &Produced, paths: &Paths) -> Result<OwnPlan, Vec<OutputError>> {
    let mut errors = Vec::new();
    let mut dirs: BTreeMap<PathBuf, DirPlan> = BTreeMap::new();
    for (dir, names) in &produced.written {
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
            for candidate in [
                entry.dir.join(format!("{name}.compact")),
                entry.dir.join(name),
            ] {
                if std::fs::symlink_metadata(&candidate).is_ok() {
                    entry.stale.push(candidate);
                }
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
    })
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
