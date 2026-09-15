//! `compact-lint.toml`: discovery, parsing, and the built-in defaults.

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

/// Tags no doc comment may carry.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct TagsConfig {
    pub forbid: Vec<Tag>,
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
            .chain(std::iter::once(&self.constraints.tag))
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
    use super::{Config, DocsPolicy, SUPPORTED_VERSION};
    use crate::doc::Tag;
    use crate::model::DeclKind;

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
    fn an_unknown_kind_is_rejected() {
        let error =
            toml::from_str::<Config>("[kinds.circiut]\n").expect_err("the kind is misspelled");

        assert!(error.to_string().contains("circiut"), "{error}");
    }
}
