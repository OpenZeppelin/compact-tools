//! Which contract a file's circuits are measured through.
//!
//! A library module does not compile on its own, so its constraints are measured through
//! the mock contract that exports the same circuit names.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::config::{Config, ConfigError, DEFAULT_SOURCES};
use crate::target::normalize;

/// Where a file's measurements come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// The measurement source, which is the file itself for a contract.
    Found(PathBuf),
    /// No candidate exists, in the order they were tried.
    Missing(Vec<PathBuf>),
}

/// The templates and globs, compiled once per run.
pub struct Resolver {
    /// Directory the config's relative paths and globs are anchored at.
    base: PathBuf,
    cwd: PathBuf,
    own: globset::GlobSet,
    sources: Vec<String>,
    overrides: Vec<(PathBuf, PathBuf)>,
    /// Module file to the sources `[mock]` generates for it, in the order
    /// `generated_sources` ranks them, tried before the templates.
    generated: BTreeMap<PathBuf, Vec<PathBuf>>,
}

impl Resolver {
    /// With the default `sources` and a `[mock]` table in `mock_config`, a module's
    /// generated mocks are tried first and the first template follows `[mock].test_dir`.
    /// # Errors
    /// Returns an error when a `constraints.self` pattern is not a valid glob.
    pub fn new(
        config: &Config,
        base: &Path,
        cwd: &Path,
        mock_config: Option<&Path>,
    ) -> Result<Self, ConfigError> {
        let mut sources = config.constraints.sources.clone();
        let mut generated = BTreeMap::new();
        if let Some(path) = mock_config
            && sources == DEFAULT_SOURCES
        {
            if let Some(tail) = compact_mock::config::mock_test_tail(path) {
                sources[0] = format!("{{dir}}/{}/artifacts/Mock{{stem}}.compact", tail.join("/"));
            }
            generated = compact_mock::coverage::generated_sources(path, cwd).unwrap_or_default();
        }
        Ok(Self {
            base: base.to_owned(),
            cwd: cwd.to_owned(),
            own: config.own_set(base)?,
            sources,
            overrides: config
                .constraints
                .overrides
                .iter()
                .map(|(file, source)| (base.join(file), base.join(source)))
                .collect(),
            generated,
        })
    }

    /// Resolves one file, trying overrides, then the `self` globs, then the templates.
    #[must_use]
    pub fn resolve(&self, file: &Path) -> Source {
        let absolute = normalize(&self.absolute(file));
        let mut tried = Vec::new();

        for (from, to) in &self.overrides {
            if normalize(from) == absolute {
                return self.first_existing(std::iter::once(self.shown(to)), &mut tried);
            }
        }

        let relative = absolute.strip_prefix(&self.base).unwrap_or(&absolute);
        if self.own.is_match(relative) {
            return Source::Found(file.to_owned());
        }

        let generated: Vec<PathBuf> = self
            .generated
            .get(&absolute)
            .into_iter()
            .flatten()
            .map(|path| self.shown(path))
            .collect();
        let mut seen = Vec::new();
        let candidates = generated
            .into_iter()
            .chain(self.candidates(file))
            .filter(|candidate| {
                let fresh = !seen.contains(candidate);
                if fresh {
                    seen.push(candidate.clone());
                }
                fresh
            });
        self.first_existing(candidates, &mut tried)
    }

    /// The templates expanded for one file, in config order.
    fn candidates(&self, file: &Path) -> impl Iterator<Item = PathBuf> {
        let directory = file.parent().unwrap_or(Path::new(".")).to_owned();
        let parent = directory.parent().map(Path::to_owned);
        let stem = file
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();

        self.sources
            .clone()
            .into_iter()
            .filter_map(move |template| expand(&template, &directory, parent.as_deref(), &stem))
    }

    fn first_existing(
        &self,
        candidates: impl Iterator<Item = PathBuf>,
        tried: &mut Vec<PathBuf>,
    ) -> Source {
        for candidate in candidates {
            if self.absolute(&candidate).is_file() {
                return Source::Found(candidate);
            }
            tried.push(candidate);
        }
        Source::Missing(std::mem::take(tried))
    }

    /// Paths under the working directory print relative to it, as the file list does.
    fn shown(&self, path: &Path) -> PathBuf {
        path.strip_prefix(&self.cwd).unwrap_or(path).to_owned()
    }

    fn absolute(&self, path: &Path) -> PathBuf {
        if path.is_absolute() {
            path.to_owned()
        } else {
            self.cwd.join(path)
        }
    }
}

/// Fills a template's placeholders; a template needing `{parent}` at the root drops out.
fn expand(template: &str, directory: &Path, parent: Option<&Path>, stem: &str) -> Option<PathBuf> {
    let mut filled = template.replace("{stem}", stem);

    if filled.contains("{parent}") {
        filled = filled.replace("{parent}", &display(parent?));
    }
    if filled.contains("{dir}") {
        filled = filled.replace("{dir}", &display(directory));
    }
    Some(normalize(Path::new(&filled)))
}

/// An empty directory renders as `.`, so a template never collapses into an absolute path.
fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if text.is_empty() {
        ".".to_owned()
    } else {
        text.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{Resolver, Source};
    use crate::config::Config;
    use std::path::{Path, PathBuf};

    /// A tree with a module, its mock one level up, an extension and a preset.
    fn tree() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("a temporary directory is available");
        for relative in [
            "src/access/Ownable.compact",
            "src/access/test/mocks/MockOwnable.compact",
            "src/token/extensions/Capped.compact",
            "src/token/test/mocks/MockCapped.compact",
            "src/multisig/presets/Vault.compact",
            "src/utils/Utils.compact",
            "src/utils/test/mocks/MockUtilities.compact",
            "src/orphan/Orphan.compact",
        ] {
            let path = directory.path().join(relative);
            std::fs::create_dir_all(path.parent().expect("the path has a directory"))
                .expect("the tree is writable");
            std::fs::write(&path, "").expect("the source is writable");
        }
        directory
    }

    fn resolve(config: &Config, root: &Path, file: &str) -> Source {
        Resolver::new(config, root, root, None)
            .expect("the globs compile")
            .resolve(Path::new(file))
    }

    #[test]
    fn a_module_measures_through_the_mock_beside_it() {
        let tree = tree();

        assert_eq!(
            resolve(
                &Config::default(),
                tree.path(),
                "src/access/Ownable.compact"
            ),
            Source::Found(PathBuf::from("src/access/test/mocks/MockOwnable.compact"))
        );
    }

    #[test]
    fn a_generated_mock_wins_over_a_hand_written_one() {
        let tree = tree();
        let generated = tree
            .path()
            .join("src/access/test/artifacts/MockOwnable.compact");
        std::fs::create_dir_all(generated.parent().expect("a parent")).expect("dirs");
        std::fs::write(&generated, "").expect("written");

        assert_eq!(
            resolve(
                &Config::default(),
                tree.path(),
                "src/access/Ownable.compact"
            ),
            Source::Found(PathBuf::from(
                "src/access/test/artifacts/MockOwnable.compact"
            ))
        );
    }

    #[test]
    fn an_extension_measures_through_the_mock_in_its_parent() {
        let tree = tree();

        assert_eq!(
            resolve(
                &Config::default(),
                tree.path(),
                "src/token/extensions/Capped.compact"
            ),
            Source::Found(PathBuf::from("src/token/test/mocks/MockCapped.compact"))
        );
    }

    #[test]
    fn a_preset_matching_a_self_glob_measures_through_itself() {
        let tree = tree();
        let mut config = Config::default();
        config.constraints.own = vec!["**/presets/**".to_owned()];

        assert_eq!(
            resolve(&config, tree.path(), "src/multisig/presets/Vault.compact"),
            Source::Found(PathBuf::from("src/multisig/presets/Vault.compact"))
        );
    }

    #[test]
    fn an_override_wins_over_the_templates() {
        let tree = tree();
        let mut config = Config::default();
        config.constraints.overrides.insert(
            "src/utils/Utils.compact".to_owned(),
            "src/utils/test/mocks/MockUtilities.compact".to_owned(),
        );

        assert_eq!(
            resolve(&config, tree.path(), "src/utils/Utils.compact"),
            Source::Found(PathBuf::from("src/utils/test/mocks/MockUtilities.compact"))
        );
    }

    #[test]
    fn a_parent_relative_template_resolves_outside_the_working_directory() {
        let tree = tempfile::tempdir().expect("a temporary directory is available");
        for relative in ["work/Ownable.compact", "mocks/Ownable.compact"] {
            let path = tree.path().join(relative);
            std::fs::create_dir_all(path.parent().expect("the path has a directory"))
                .expect("the tree is writable");
            std::fs::write(&path, "").expect("the source is writable");
        }

        let mut config = Config::default();
        config.constraints.sources = vec!["../mocks/{stem}.compact".to_owned()];
        let work = tree.path().join("work");

        assert_eq!(
            resolve(&config, &work, "Ownable.compact"),
            Source::Found(PathBuf::from("../mocks/Ownable.compact"))
        );
    }

    #[test]
    fn a_file_with_no_candidate_reports_the_paths_it_tried() {
        let tree = tree();

        assert_eq!(
            resolve(&Config::default(), tree.path(), "src/orphan/Orphan.compact"),
            Source::Missing(vec![
                PathBuf::from("src/orphan/test/artifacts/MockOrphan.compact"),
                PathBuf::from("src/orphan/test/mocks/MockOrphan.compact"),
                PathBuf::from("src/test/mocks/MockOrphan.compact"),
            ])
        );
    }
}
