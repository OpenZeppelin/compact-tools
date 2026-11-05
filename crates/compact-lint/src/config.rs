//! `compact-lint.toml`: discovery, parsing, and the built-in defaults.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use thiserror::Error;

use crate::doc::Tag;
use crate::model::DeclKind;

/// The config file name searched for upward from the current directory.
pub const CONFIG_FILE_NAME: &str = "compact-lint.toml";

/// The only schema version this build understands.
pub const SUPPORTED_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("cannot read config {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot parse config {path}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error(
        "config {path} is version {found}, but this build understands version {SUPPORTED_VERSION}"
    )]
    Version { path: PathBuf, found: u32 },
    #[error(
        "config {path} lists tag {tag:?}; tags are spelled with their `@`, like `@description`"
    )]
    Tag { path: PathBuf, tag: String },
    #[error("config {path} renames {tag}, which tags.forbid does not list")]
    RenameUnforbidden { path: PathBuf, tag: String },
    #[error("config {path} renames {from} to {to}, which tags.forbid also lists")]
    RenameToForbidden {
        path: PathBuf,
        from: String,
        to: String,
    },
    #[error("config {path} has an invalid fix.placeholder {placeholder:?}: {reason}")]
    Placeholder {
        path: PathBuf,
        placeholder: String,
        reason: &'static str,
    },
    #[error("config {path} has an invalid glob {pattern:?}")]
    Glob {
        path: PathBuf,
        pattern: String,
        #[source]
        source: globset::Error,
    },
}

/// How much of a kind needs documenting.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocsPolicy {
    /// Every declaration of the kind.
    All,
    /// Only declarations carrying the `export` token.
    #[default]
    Exported,
    /// The kind is not checked for docs.
    None,
}

/// Per-kind requirements.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct KindConfig {
    pub docs: DocsPolicy,
    pub tags: Vec<Tag>,
}

/// One table per checked declaration kind.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct KindsConfig {
    pub module: KindConfig,
    pub circuit: KindConfig,
    pub ledger: KindConfig,
    pub witness: KindConfig,
    pub constructor: KindConfig,
    #[serde(rename = "struct")]
    pub struct_: KindConfig,
    #[serde(rename = "enum")]
    pub enum_: KindConfig,
    pub contract: KindConfig,
    #[serde(rename = "type")]
    pub type_: KindConfig,
}

impl KindsConfig {
    #[must_use]
    pub fn get(&self, kind: DeclKind) -> &KindConfig {
        match kind {
            DeclKind::Module => &self.module,
            DeclKind::Circuit => &self.circuit,
            DeclKind::Ledger => &self.ledger,
            DeclKind::Witness => &self.witness,
            DeclKind::Constructor => &self.constructor,
            DeclKind::Struct => &self.struct_,
            DeclKind::Enum => &self.enum_,
            DeclKind::Contract => &self.contract,
            DeclKind::Type => &self.type_,
        }
    }
}

/// The circuit constraints annotation.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct ConstraintsConfig {
    pub tag: Tag,
}

impl Default for ConstraintsConfig {
    fn default() -> Self {
        Self {
            tag: Tag::new("@constraints"),
        }
    }
}

/// Tags no doc comment may carry, and the replacements `fix` writes for them.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct TagsConfig {
    pub forbid: Vec<Tag>,
    /// Forbidden tag to its replacement; an unmapped forbidden tag stays a finding.
    pub rename: BTreeMap<Tag, Tag>,
}

/// What `fix` writes where it has no value to write.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct FixConfig {
    pub placeholder: String,
}

impl Default for FixConfig {
    fn default() -> Self {
        Self {
            placeholder: "TODO".to_owned(),
        }
    }
}

/// A parsed `compact-lint.toml`, or the built-in defaults when no file was found.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub version: u32,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub constraints: ConstraintsConfig,
    pub tags: TagsConfig,
    pub fix: FixConfig,
    pub kinds: KindsConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: SUPPORTED_VERSION,
            include: vec!["**/*.compact".to_owned()],
            exclude: Vec::new(),
            constraints: ConstraintsConfig::default(),
            tags: TagsConfig::default(),
            fix: FixConfig::default(),
            kinds: KindsConfig::default(),
        }
    }
}

impl Config {
    /// Parses a config file and rejects a version this build does not implement.
    /// # Errors
    /// Returns an error when the file is unreadable, malformed, or a future version.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_owned(),
            source,
        })?;

        let config: Self = toml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.to_owned(),
            source,
        })?;

        if config.version != SUPPORTED_VERSION {
            return Err(ConfigError::Version {
                path: path.to_owned(),
                found: config.version,
            });
        }

        if let Some(tag) = config.tags().find(|tag| !tag.is_well_formed()) {
            return Err(ConfigError::Tag {
                path: path.to_owned(),
                tag: tag.to_string(),
            });
        }

        for (from, to) in &config.tags.rename {
            if !config.tags.forbid.contains(from) {
                return Err(ConfigError::RenameUnforbidden {
                    path: path.to_owned(),
                    tag: from.to_string(),
                });
            }
            if config.tags.forbid.contains(to) {
                return Err(ConfigError::RenameToForbidden {
                    path: path.to_owned(),
                    from: from.to_string(),
                    to: to.to_string(),
                });
            }
        }

        if let Some(reason) = placeholder_defect(&config.fix.placeholder) {
            return Err(ConfigError::Placeholder {
                path: path.to_owned(),
                placeholder: config.fix.placeholder.clone(),
                reason,
            });
        }

        Ok(config)
    }

    /// Every tag the config mentions: required per kind, forbidden, and the constraints tag.
    fn tags(&self) -> impl Iterator<Item = &Tag> {
        let per_kind = [
            &self.kinds.module,
            &self.kinds.circuit,
            &self.kinds.ledger,
            &self.kinds.witness,
            &self.kinds.constructor,
            &self.kinds.struct_,
            &self.kinds.enum_,
            &self.kinds.contract,
            &self.kinds.type_,
        ]
        .into_iter()
        .flat_map(|kind| kind.tags.iter());

        per_kind
            .chain(self.tags.forbid.iter())
            .chain(self.tags.rename.keys())
            .chain(self.tags.rename.values())
            .chain(std::iter::once(&self.constraints.tag))
    }

    /// The replacement `fix` writes for a forbidden tag, when the config names one.
    #[must_use]
    pub fn rename_of(&self, tag: &Tag) -> Option<&Tag> {
        self.tags.rename.get(tag)
    }

    /// Compiles the `include` globs.
    /// # Errors
    /// Returns an error when a pattern is not a valid glob.
    pub fn include_set(&self, path: &Path) -> Result<GlobSet, ConfigError> {
        glob_set(&self.include, path)
    }

    /// Compiles the `exclude` globs; an empty set matches nothing.
    /// # Errors
    /// Returns an error when a pattern is not a valid glob.
    pub fn exclude_set(&self, path: &Path) -> Result<GlobSet, ConfigError> {
        glob_set(&self.exclude, path)
    }
}

/// Why a placeholder cannot go on a `*` line of a doc comment, or `None` when it can.
fn placeholder_defect(placeholder: &str) -> Option<&'static str> {
    if placeholder.trim().is_empty() {
        return Some("it is empty");
    }
    if placeholder.contains(['\n', '\r']) {
        return Some("it spans more than one line");
    }
    if placeholder.contains("*/") {
        return Some("`*/` would close the comment early");
    }
    None
}

fn glob_set(patterns: &[String], path: &Path) -> Result<GlobSet, ConfigError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = Glob::new(pattern).map_err(|source| ConfigError::Glob {
            path: path.to_owned(),
            pattern: pattern.clone(),
            source,
        })?;
        builder.add(glob);
    }
    builder.build().map_err(|source| ConfigError::Glob {
        path: path.to_owned(),
        pattern: String::new(),
        source,
    })
}

/// Walks up from `start` looking for `compact-lint.toml`.
#[must_use]
pub fn discover(start: &Path) -> Option<PathBuf> {
    for directory in start.ancestors() {
        let candidate = directory.join(CONFIG_FILE_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{CONFIG_FILE_NAME, Config, DocsPolicy, SUPPORTED_VERSION};
    use crate::doc::Tag;
    use crate::model::DeclKind;
    use tempfile::TempDir;

    /// Loads `snippet` as a config file and returns the rejection it produced.
    fn rejection(snippet: &str) -> String {
        let directory = TempDir::new().expect("a temporary directory is available");
        let path = directory.path().join(CONFIG_FILE_NAME);
        std::fs::write(&path, snippet).expect("the config is writable");

        Config::load(&path)
            .expect_err("the config is invalid")
            .to_string()
    }

    #[test]
    fn defaults_require_docs_on_exported_declarations_only() {
        let config = Config::default();

        assert_eq!(config.version, SUPPORTED_VERSION);
        assert_eq!(config.constraints.tag, Tag::new("@constraints"));
        for kind in [DeclKind::Module, DeclKind::Circuit, DeclKind::Type] {
            assert_eq!(config.kinds.get(kind).docs, DocsPolicy::Exported);
            assert!(config.kinds.get(kind).tags.is_empty());
        }
    }

    #[test]
    fn omitted_tables_fall_back_to_defaults() {
        let config: Config = toml::from_str("version = 1\n[kinds.witness]\ndocs = \"all\"\n")
            .expect("the snippet is valid config");

        assert_eq!(config.kinds.witness.docs, DocsPolicy::All);
        assert_eq!(config.kinds.circuit.docs, DocsPolicy::Exported);
        assert_eq!(config.include, ["**/*.compact"]);
    }

    #[test]
    fn an_unknown_key_is_rejected() {
        let error = toml::from_str::<Config>("verison = 1\n").expect_err("the key is misspelled");

        assert!(error.to_string().contains("verison"), "{error}");
    }

    #[test]
    fn a_tag_without_its_at_sign_is_rejected() {
        let dir = std::env::temp_dir().join(format!("compact-lint-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("the temp dir is writable");
        let path = dir.join("compact-lint.toml");
        std::fs::write(&path, "[kinds.circuit]\ntags = [\"description\"]\n")
            .expect("the config is writable");

        let error = Config::load(&path).expect_err("the tag lacks its @");

        assert!(error.to_string().contains("\"description\""), "{error}");
        std::fs::remove_dir_all(&dir).expect("the temp dir is removable");
    }

    #[test]
    fn a_rename_maps_a_forbidden_tag_to_its_replacement() {
        let config: Config = toml::from_str(
            "[tags]\nforbid = [\"@return\"]\nrename = { \"@return\" = \"@returns\" }\n",
        )
        .expect("the snippet is valid config");

        assert_eq!(
            config.rename_of(&Tag::new("@return")),
            Some(&Tag::new("@returns"))
        );
        assert_eq!(config.rename_of(&Tag::new("@notice")), None);
    }

    #[test]
    fn a_rename_target_without_its_at_sign_is_rejected() {
        let dir = std::env::temp_dir().join(format!("compact-lint-rename-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("the temp dir is writable");
        let path = dir.join("compact-lint.toml");
        std::fs::write(&path, "[tags]\nrename = { \"@return\" = \"returns\" }\n")
            .expect("the config is writable");

        let error = Config::load(&path).expect_err("the replacement lacks its @");

        assert!(error.to_string().contains("\"returns\""), "{error}");
        std::fs::remove_dir_all(&dir).expect("the temp dir is removable");
    }

    #[test]
    fn the_fix_placeholder_defaults_to_todo() {
        assert_eq!(Config::default().fix.placeholder, "TODO");

        let config: Config = toml::from_str("[fix]\nplaceholder = \"FIXME\"\n")
            .expect("the snippet is valid config");
        assert_eq!(config.fix.placeholder, "FIXME");
    }

    #[test]
    fn a_rename_of_a_tag_that_is_not_forbidden_is_rejected() {
        let error = rejection("[tags]\nrename = { \"@return\" = \"@returns\" }\n");

        assert!(error.contains("@return"), "{error}");
        assert!(error.contains("tags.forbid does not list"), "{error}");
    }

    #[test]
    fn a_rename_onto_a_forbidden_tag_is_rejected() {
        let error = rejection(
            "[tags]\nforbid = [\"@return\", \"@returns\"]\nrename = { \"@return\" = \"@returns\" }\n",
        );

        assert!(error.contains("tags.forbid also lists"), "{error}");
    }

    #[test]
    fn an_empty_fix_placeholder_is_rejected() {
        let error = rejection("[fix]\nplaceholder = \"  \"\n");

        assert!(error.contains("is empty"), "{error}");
    }

    #[test]
    fn a_multi_line_fix_placeholder_is_rejected() {
        let error = rejection("[fix]\nplaceholder = \"TO\\nDO\"\n");

        assert!(error.contains("more than one line"), "{error}");
    }

    #[test]
    fn a_fix_placeholder_closing_the_comment_is_rejected() {
        let error = rejection("[fix]\nplaceholder = \"TODO */\"\n");

        assert!(error.contains("close the comment"), "{error}");
    }

    #[test]
    fn an_unknown_kind_is_rejected() {
        let error =
            toml::from_str::<Config>("[kinds.circiut]\n").expect_err("the kind is misspelled");

        assert!(error.to_string().contains("circiut"), "{error}");
    }
}
