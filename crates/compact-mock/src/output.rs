//! Rendering targets and writing files through a temporary file and a rename.
//!
//! Which directories may be written is decided in [`crate::own`]. Fragments are never
//! written, created or compared.

use std::io;
use std::path::{Path, PathBuf};

use crate::config::Paths;
use crate::error::OutputError;
use crate::plan::MockPlan;
use crate::render::render;

/// A rendered mock and what is on disk at its path.
#[derive(Clone, Debug)]
pub struct Target {
    pub name: String,
    pub path: PathBuf,
    pub artifacts: PathBuf,
    pub shown: String,
    pub text: String,
    /// The current bytes, when the file exists.
    pub existing: Option<Vec<u8>>,
}

/// What `generate` did to one file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Written {
    Wrote,
    Unchanged,
}

/// Renders a plan and reads its target.
/// # Errors
/// Returns the read error of an existing target.
pub fn target(plan: &MockPlan, paths: &Paths) -> Result<Target, OutputError> {
    let shown = paths.show(&plan.path);
    let existing = match std::fs::symlink_metadata(&plan.path) {
        Ok(_) => Some(
            std::fs::read(&plan.path).map_err(|source| OutputError::Read {
                path: shown.clone(),
                source,
            })?,
        ),
        Err(_) => None,
    };
    Ok(Target {
        name: plan.name.clone(),
        path: plan.path.clone(),
        artifacts: plan.artifacts.clone(),
        shown,
        text: render(plan),
        existing,
    })
}

/// Writes the target when its bytes changed.
/// # Errors
/// Returns the IO error, with the target's path.
pub fn write(target: &Target) -> Result<Written, OutputError> {
    if target.existing.as_deref() == Some(target.text.as_bytes()) {
        return Ok(Written::Unchanged);
    }
    replace(&target.path, target.text.as_bytes()).map_err(|source| OutputError::Write {
        path: target.shown.clone(),
        source,
    })?;
    Ok(Written::Wrote)
}

/// Writes `bytes` to `path` through a temporary file in the same directory and a rename,
/// so no reader sees a torn file.
/// # Errors
/// Returns the IO error.
pub fn replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory)?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temporary = directory.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, path));
    if result.is_err() {
        // Best effort: the rename error is the one worth reporting.
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{Target, Written, replace, write};

    fn target(directory: &std::path::Path, existing: Option<&str>) -> Target {
        let path = directory.join("artifacts/MockM.compact");
        Target {
            name: "MockM".to_owned(),
            path,
            artifacts: directory.join("artifacts"),
            shown: "artifacts/MockM.compact".to_owned(),
            text: "text\n".to_owned(),
            existing: existing.map(|text| text.as_bytes().to_vec()),
        }
    }

    #[test]
    fn a_target_is_written_only_when_its_bytes_change() {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        let fresh = target(directory.path(), None);
        assert_eq!(write(&fresh).expect("writes"), Written::Wrote);
        assert_eq!(
            std::fs::read_to_string(&fresh.path).expect("reads"),
            "text\n"
        );
        let same = target(directory.path(), Some("text\n"));
        assert_eq!(write(&same).expect("writes"), Written::Unchanged);
    }

    #[test]
    fn a_replace_leaves_no_temporary_file_behind() {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        let path = directory.path().join("a/b.txt");
        replace(&path, b"one").expect("writes");
        replace(&path, b"two").expect("writes");
        let names: Vec<String> = std::fs::read_dir(directory.path().join("a"))
            .expect("lists")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, ["b.txt"]);
        assert_eq!(std::fs::read(&path).expect("reads"), b"two");
    }
}
