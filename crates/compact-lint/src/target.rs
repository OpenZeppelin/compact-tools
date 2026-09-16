//! What a subcommand runs over: the resolved config plus the file list.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::{Config, ConfigError, discover as discover_config};
use crate::discover::{self, DiscoverError};

#[derive(Debug, Error)]
pub enum TargetError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Discover(#[from] DiscoverError),
}

/// The config and the files it selects, shared by `check` and `fix`.
pub struct Target {
    pub config: Config,
    pub files: Vec<PathBuf>,
}

/// Resolves the config and the file list for one run.
///
/// An explicit `config_path` is a shareable preset, so glob discovery stays anchored at
/// `cwd`; a config found by walking upward anchors discovery at its own directory.
/// # Errors
/// Returns an error when the config is unreadable or a path cannot be walked.
pub fn resolve(
    paths: &[PathBuf],
    config_path: Option<&Path>,
    cwd: &Path,
) -> Result<Target, TargetError> {
    let (config, source, base) = match config_path {
        Some(path) => (Config::load(path)?, path.to_owned(), cwd.to_owned()),
        None => match discover_config(cwd) {
            Some(path) => {
                let base = path.parent().unwrap_or(cwd).to_owned();
                (Config::load(&path)?, path, base)
            }
            None => (
                Config::default(),
                PathBuf::from("<defaults>"),
                cwd.to_owned(),
            ),
        },
    };

    let exclude = config.exclude_set(&source)?;
    let files = if paths.is_empty() {
        let include = config.include_set(&source)?;
        discover::from_globs(&base, &include, &exclude)?
    } else {
        let paths = absolute_paths(paths, cwd);
        discover::from_paths(&paths, &base, &exclude)?
    };

    let files = files.iter().map(|path| display_path(path, cwd)).collect();
    Ok(Target { config, files })
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
