//! Turning CLI paths and config globs into the list of files to check.

use std::path::{Path, PathBuf};

use globset::GlobSet;
use thiserror::Error;
use walkdir::WalkDir;

/// Directories that never hold first-party Compact sources.
const SKIPPED_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", ".git"];

const COMPACT_EXTENSION: &str = "compact";

#[derive(Debug, Error)]
pub enum DiscoverError {
    #[error("cannot walk {path}")]
    Walk {
        path: PathBuf,
        #[source]
        source: walkdir::Error,
    },
    #[error("path {0} does not exist")]
    Missing(PathBuf),
}

/// Collects the `.compact` files under the given paths.
///
/// A path named on the command line is always checked, even when `exclude` matches
/// it; files found by walking a directory are filtered by `exclude`.
/// # Errors
/// Returns an error when a path does not exist or a directory cannot be walked.
pub fn from_paths(
    paths: &[PathBuf],
    base: &Path,
    exclude: &GlobSet,
) -> Result<Vec<PathBuf>, DiscoverError> {
    let mut files = Vec::new();

    for path in paths {
        if path.is_file() {
            files.push(path.clone());
        } else if path.is_dir() {
            walk(path, base, exclude, None, &mut files)?;
        } else {
            return Err(DiscoverError::Missing(path.clone()));
        }
    }

    Ok(sorted(files))
}

/// Collects the `.compact` files under `base` that `include` matches and `exclude` does not.
/// # Errors
/// Returns an error when `base` cannot be walked.
pub fn from_globs(
    base: &Path,
    include: &GlobSet,
    exclude: &GlobSet,
) -> Result<Vec<PathBuf>, DiscoverError> {
    let mut files = Vec::new();
    walk(base, base, exclude, Some(include), &mut files)?;
    Ok(sorted(files))
}

fn walk(
    root: &Path,
    base: &Path,
    exclude: &GlobSet,
    include: Option<&GlobSet>,
    out: &mut Vec<PathBuf>,
) -> Result<(), DiscoverError> {
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_skipped_dir(entry.file_name()));

    for entry in walker {
        let entry = entry.map_err(|source| DiscoverError::Walk {
            path: root.to_owned(),
            source,
        })?;

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if path
            .extension()
            .is_none_or(|extension| extension != COMPACT_EXTENSION)
        {
            continue;
        }

        let relative = path.strip_prefix(base).unwrap_or(path);
        if include.is_some_and(|set| !set.is_match(relative)) || exclude.is_match(relative) {
            continue;
        }

        out.push(path.to_owned());
    }

    Ok(())
}

fn is_skipped_dir(name: &std::ffi::OsStr) -> bool {
    SKIPPED_DIRS.iter().any(|skipped| name == *skipped)
}

fn sorted(mut files: Vec<PathBuf>) -> Vec<PathBuf> {
    files.sort();
    files.dedup();
    files
}
