//! `compact.toml`: discovery, parsing, and the built-in defaults.
//!
//! The file is shared with `compact-deploy`. The linter reads its `[lint]` table and
//! ignores every other one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use thiserror::Error;

use crate::diagnostic::Level;
use crate::doc::{Tag, TagSpec};
use crate::model::DeclKind;
use crate::report::RuleId;

/// The config file name searched for upward from the current directory.
pub const CONFIG_FILE_NAME: &str = "compact.toml";

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
    #[error("{CONFIG_FILE_NAME} at {path} has no [lint] table")]
    MissingLintTable { path: PathBuf },
    #[error(
        "config {path} lists tag {tag:?}; tags are spelled with their `@`, like `@description`"
    )]
    Tag { path: PathBuf, tag: String },
    #[error("config {path}: kinds.{kind}.tags lists {entry}, but kinds.{kind}.sections does not")]
    NotInSections {
        path: PathBuf,
        kind: &'static str,
        entry: String,
    },
    #[error(
        "config {path} lists {entry:?} under kinds.{kind}; a heading is non-empty and carries no `:`"
    )]
    Heading {
        path: PathBuf,
        kind: &'static str,
        entry: String,
    },
    #[error("config {path} lists {entry:?} twice under kinds.{kind}")]
    DuplicateEntry {
        path: PathBuf,
        kind: &'static str,
        entry: String,
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
    /// Entries every doc comment of the kind carries; each one also appears in `sections`.
    pub tags: Vec<TagSpec>,
    /// Every section the template allows, in template order; empty leaves `tags` the order.
    pub sections: Vec<TagSpec>,
}

impl KindConfig {
    /// The ordered template: `sections` where the kind has one, else the required entries.
    pub fn entries(&self) -> impl Iterator<Item = &TagSpec> {
        if self.sections.is_empty() {
            self.tags.iter()
        } else {
            self.sections.iter()
        }
    }
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
    /// Every kind table, keyed by the name its config section uses.
    #[must_use]
    pub fn all(&self) -> [(&'static str, &KindConfig); 9] {
        [
            ("module", &self.module),
            ("circuit", &self.circuit),
            ("ledger", &self.ledger),
            ("witness", &self.witness),
            ("constructor", &self.constructor),
            ("struct", &self.struct_),
            ("enum", &self.enum_),
            ("contract", &self.contract),
            ("type", &self.type_),
        ]
    }

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

/// Where `fill-constraints` looks for the contract that measures a file, tried in order.
///
/// `{dir}` is the file's directory, `{parent}` its parent, `{stem}` its name without
/// the extension.
pub const DEFAULT_SOURCES: [&str; 2] = [
    "{dir}/test/mocks/Mock{stem}.compact",
    "{parent}/test/mocks/Mock{stem}.compact",
];

/// Where the compiler writes, and where `fill-constraints` reads a measurement from.
pub const DEFAULT_ARTIFACTS: &str = "artifacts";

/// The circuit constraints annotation, and how `fill-constraints` measures it.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct ConstraintsConfig {
    pub tag: Tag,
    /// Toolchain version passed as `+<version>`; none leaves `compact` on its default.
    pub compiler: Option<String>,
    /// Artifacts tree, relative to this file's directory; `--artifacts` overrides it.
    pub artifacts: PathBuf,
    /// Measurement-source templates, first existing file wins.
    pub sources: Vec<String>,
    /// Globs for files that are contracts and compile themselves.
    #[serde(rename = "self")]
    pub own: Vec<String>,
    /// File to its measurement source, both relative to the config's directory.
    pub overrides: BTreeMap<String, String>,
}

impl Default for ConstraintsConfig {
    fn default() -> Self {
        Self {
            tag: Tag::new("@constraints"),
            compiler: None,
            artifacts: PathBuf::from(DEFAULT_ARTIFACTS),
            sources: DEFAULT_SOURCES
                .iter()
                .map(|&template| template.to_owned())
                .collect(),
            own: Vec::new(),
            overrides: BTreeMap::new(),
        }
    }
}

/// The level each rule reports at; `off` stops it running.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct RulesConfig {
    #[serde(rename = "missing-doc")]
    pub missing_doc: Level,
    #[serde(rename = "missing-tag")]
    pub missing_tag: Level,
    #[serde(rename = "unknown-section")]
    pub unknown_section: Level,
    #[serde(rename = "tag-order")]
    pub tag_order: Level,
    #[serde(rename = "forbidden-tag")]
    pub forbidden_tag: Level,
    #[serde(rename = "module-name")]
    pub module_name: Level,
    #[serde(rename = "missing-constraints")]
    pub missing_constraints: Level,
    #[serde(rename = "constraints-format")]
    pub constraints_format: Level,
    #[serde(rename = "constraints-placeholder")]
    pub constraints_placeholder: Level,
    #[serde(rename = "constraints-unmeasured")]
    pub constraints_unmeasured: Level,
    #[serde(rename = "constraints-unmeasurable")]
    pub constraints_unmeasurable: Level,
    pub parse: Level,
    pub format: Level,
}

impl Default for RulesConfig {
    fn default() -> Self {
        Self {
            missing_doc: Level::Error,
            missing_tag: Level::Error,
            // A heading the template does not list is a candidate for it, not a defect.
            unknown_section: Level::Warn,
            tag_order: Level::Error,
            forbidden_tag: Level::Error,
            module_name: Level::Error,
            missing_constraints: Level::Error,
            constraints_format: Level::Error,
            // A placeholder is a value waiting on a measurement, not a defect; `--strict`
            // promotes it on release branches.
            constraints_placeholder: Level::Warn,
            constraints_unmeasured: Level::Warn,
            constraints_unmeasurable: Level::Warn,
            parse: Level::Error,
            format: Level::Error,
        }
    }
}

impl RulesConfig {
    #[must_use]
    pub fn get(&self, rule: RuleId) -> Level {
        match rule {
            RuleId::MISSING_DOC => self.missing_doc,
            RuleId::MISSING_TAG => self.missing_tag,
            RuleId::UNKNOWN_SECTION => self.unknown_section,
            RuleId::TAG_ORDER => self.tag_order,
            RuleId::FORBIDDEN_TAG => self.forbidden_tag,
            RuleId::MODULE_NAME => self.module_name,
            RuleId::MISSING_CONSTRAINTS => self.missing_constraints,
            RuleId::CONSTRAINTS_FORMAT => self.constraints_format,
            RuleId::CONSTRAINTS_PLACEHOLDER => self.constraints_placeholder,
            RuleId::CONSTRAINTS_UNMEASURED => self.constraints_unmeasured,
            RuleId::CONSTRAINTS_UNMEASURABLE => self.constraints_unmeasurable,
            RuleId::PARSE => self.parse,
            RuleId::FORMAT => self.format,
            // `fill` reports what changed, so it is not configurable.
            _ => Level::Info,
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

/// The whole `compact.toml`. Tables other tools own are ignored, so the root rejects
/// nothing.
#[derive(Debug, Default, Deserialize)]
struct Document {
    lint: Option<Config>,
}

/// A parsed `[lint]` table, or the built-in defaults when no file was found.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub constraints: ConstraintsConfig,
    pub tags: TagsConfig,
    pub fix: FixConfig,
    pub kinds: KindsConfig,
    pub rules: RulesConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            include: vec!["**/*.compact".to_owned()],
            exclude: Vec::new(),
            constraints: ConstraintsConfig::default(),
            tags: TagsConfig::default(),
            fix: FixConfig::default(),
            kinds: KindsConfig::default(),
            rules: RulesConfig::default(),
        }
    }
}

impl Config {
    /// Parses a config file's `[lint]` table.
    /// # Errors
    /// Returns an error when the file is unreadable or malformed, or carries no `[lint]`
    /// table.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_owned(),
            source,
        })?;

        let document: Document = toml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.to_owned(),
            source,
        })?;

        let config = document.lint.ok_or_else(|| ConfigError::MissingLintTable {
            path: path.to_owned(),
        })?;

        if let Some(tag) = config.tags().find(|tag| !tag.is_well_formed()) {
            return Err(ConfigError::Tag {
                path: path.to_owned(),
                tag: tag.to_string(),
            });
        }
        config.validate_entries(path)?;

        Ok(config)
    }

    /// A heading is well formed, no list repeats an entry, and a required entry takes its
    /// place in the section order.
    fn validate_entries(&self, path: &Path) -> Result<(), ConfigError> {
        for (kind, config) in self.kinds.all() {
            for list in [&config.tags, &config.sections] {
                let mut seen: Vec<String> = Vec::new();
                for entry in list {
                    if !entry.has_well_formed_heading() {
                        return Err(ConfigError::Heading {
                            path: path.to_owned(),
                            kind,
                            entry: entry.to_string(),
                        });
                    }
                    let spelling = entry.to_string();
                    if seen.contains(&spelling) {
                        return Err(ConfigError::DuplicateEntry {
                            path: path.to_owned(),
                            kind,
                            entry: spelling,
                        });
                    }
                    seen.push(spelling);
                }
            }

            if config.sections.is_empty() {
                continue;
            }
            if let Some(entry) = config
                .tags
                .iter()
                .find(|required| !config.sections.contains(required))
            {
                return Err(ConfigError::NotInSections {
                    path: path.to_owned(),
                    kind,
                    entry: entry.to_string(),
                });
            }
        }
        Ok(())
    }

    /// Every tag the config mentions: the kind templates, the forbidden set, and the
    /// constraints tag.
    fn tags(&self) -> impl Iterator<Item = &Tag> {
        let per_kind = self.kinds.all().into_iter().flat_map(|(_, kind)| {
            kind.tags
                .iter()
                .chain(kind.sections.iter())
                .map(|entry| &entry.tag)
        });

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

    /// Compiles the `constraints.self` globs; an empty set matches nothing.
    /// # Errors
    /// Returns an error when a pattern is not a valid glob.
    pub fn own_set(&self, path: &Path) -> Result<GlobSet, ConfigError> {
        glob_set(&self.constraints.own, path)
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

/// Walks up from `start` looking for `compact.toml`.
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
    use super::{Config, DocsPolicy};
    use crate::diagnostic::Level;
    use crate::doc::{Tag, TagSpec};
    use crate::model::DeclKind;
    use crate::report::RuleId;

    #[test]
    fn every_rule_defaults_to_error_but_the_ones_awaiting_a_measurement() {
        let rules = Config::default().rules;

        assert_eq!(rules.get(RuleId::MISSING_DOC), Level::Error);
        assert_eq!(rules.get(RuleId::PARSE), Level::Error);
        assert_eq!(rules.get(RuleId::FORMAT), Level::Error);
        assert_eq!(rules.get(RuleId::TAG_ORDER), Level::Error);
        assert_eq!(rules.get(RuleId::UNKNOWN_SECTION), Level::Warn);
        assert_eq!(rules.get(RuleId::CONSTRAINTS_PLACEHOLDER), Level::Warn);
        assert_eq!(rules.get(RuleId::CONSTRAINTS_UNMEASURED), Level::Warn);
        assert_eq!(rules.get(RuleId::CONSTRAINTS_UNMEASURABLE), Level::Warn);
    }

    #[test]
    fn a_rules_table_sets_only_the_rules_it_names() {
        let config: Config = toml::from_str("[rules]\nmissing-doc = \"off\"\nformat = \"warn\"\n")
            .expect("the snippet is valid config");

        assert_eq!(config.rules.get(RuleId::MISSING_DOC), Level::Off);
        assert_eq!(config.rules.get(RuleId::FORMAT), Level::Warn);
        assert_eq!(config.rules.get(RuleId::MISSING_TAG), Level::Error);
    }

    #[test]
    fn an_unknown_rule_key_is_rejected() {
        let error = toml::from_str::<Config>("[rules]\nmissing-docs = \"off\"\n")
            .expect_err("the rule is misspelled");

        assert!(error.to_string().contains("missing-docs"), "{error}");
    }

    #[test]
    fn defaults_require_docs_on_exported_declarations_only() {
        let config = Config::default();

        assert_eq!(config.constraints.tag, Tag::new("@constraints"));
        for kind in [DeclKind::Module, DeclKind::Circuit, DeclKind::Type] {
            assert_eq!(config.kinds.get(kind).docs, DocsPolicy::Exported);
            assert!(config.kinds.get(kind).tags.is_empty());
        }
    }

    #[test]
    fn omitted_tables_fall_back_to_defaults() {
        let config: Config = toml::from_str("[kinds.witness]\ndocs = \"all\"\n")
            .expect("the snippet is valid config");

        assert_eq!(config.kinds.witness.docs, DocsPolicy::All);
        assert_eq!(config.kinds.circuit.docs, DocsPolicy::Exported);
        assert_eq!(config.include, ["**/*.compact"]);
    }

    #[test]
    fn an_unknown_key_is_rejected() {
        let error = toml::from_str::<Config>("inclued = []\n").expect_err("the key is misspelled");

        assert!(error.to_string().contains("inclued"), "{error}");
    }

    #[test]
    fn a_tag_without_its_at_sign_is_rejected() {
        let dir = std::env::temp_dir().join(format!("compact-lint-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("the temp dir is writable");
        let path = dir.join("compact.toml");
        std::fs::write(&path, "[lint.kinds.circuit]\ntags = [\"description\"]\n")
            .expect("the config is writable");

        let error = Config::load(&path).expect_err("the tag lacks its @");

        assert!(error.to_string().contains("\"description\""), "{error}");
        std::fs::remove_dir_all(&dir).expect("the temp dir is removable");
    }

    #[test]
    fn a_tag_entry_keeps_the_heading_after_its_tag() {
        let config: Config = toml::from_str(
            "[kinds.module]\ntags = [\"@module\", \"@notice Privacy\"]\nsections = [\"@dev Notation\"]\n",
        )
        .expect("the snippet is valid config");

        assert_eq!(config.kinds.module.tags[0], TagSpec::parse("@module"));
        assert_eq!(
            config.kinds.module.tags[1].heading.as_deref(),
            Some("Privacy")
        );
        assert_eq!(config.kinds.module.sections[0].tag, Tag::new("@dev"));
        assert!(config.kinds.circuit.sections.is_empty());
    }

    #[test]
    fn a_required_entry_missing_from_the_section_order_is_rejected() {
        let error = load_document(
            "not-in-sections",
            "[lint.kinds.module]\ntags = [\"@module\", \"@notice Privacy\"]\nsections = [\"@module\", \"@dev Notation\"]\n",
        )
        .expect_err("a required entry takes its place in the section order");

        assert!(
            error.to_string().contains(
                "kinds.module.tags lists @notice Privacy, but kinds.module.sections does not"
            ),
            "{error}"
        );
    }

    #[test]
    fn the_section_order_replaces_the_tag_order_where_the_kind_has_one() {
        let bare: Config =
            toml::from_str("[kinds.module]\ntags = [\"@module\", \"@description\"]\n")
                .expect("the snippet is valid config");
        let ordered: Config = toml::from_str(
            "[kinds.module]\ntags = [\"@module\", \"@notice Privacy\"]\nsections = [\"@module\", \"@dev Notation\", \"@notice Privacy\"]\n",
        )
        .expect("the snippet is valid config");

        let spelled = |config: &Config| -> Vec<String> {
            config
                .kinds
                .module
                .entries()
                .map(ToString::to_string)
                .collect()
        };

        assert_eq!(spelled(&bare), ["@module", "@description"]);
        assert_eq!(
            spelled(&ordered),
            ["@module", "@dev Notation", "@notice Privacy"]
        );
    }

    #[test]
    fn a_heading_carrying_a_colon_is_rejected() {
        let error = load_document(
            "colon-heading",
            "[lint.kinds.module]\ntags = [\"@notice Privacy:\"]\n",
        )
        .expect_err("the occurrence writes the colon, not the config");

        assert!(error.to_string().contains("@notice Privacy:"), "{error}");
    }

    #[test]
    fn an_entry_listed_twice_in_one_list_is_rejected() {
        let error = load_document(
            "duplicate-entry",
            "[lint.kinds.module]\nsections = [\"@notice Privacy\", \"@notice Privacy\"]\n",
        )
        .expect_err("a list names an entry once");

        assert!(error.to_string().contains("twice"), "{error}");
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
        let path = dir.join("compact.toml");
        std::fs::write(
            &path,
            "[lint.tags]\nrename = { \"@return\" = \"returns\" }\n",
        )
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
    fn constraints_default_to_the_mock_templates_and_no_compiler_pin() {
        let constraints = Config::default().constraints;

        assert_eq!(constraints.compiler, None);
        assert_eq!(constraints.artifacts, std::path::Path::new("artifacts"));
        assert_eq!(constraints.sources, super::DEFAULT_SOURCES);
        assert!(constraints.own.is_empty());
        assert!(constraints.overrides.is_empty());
    }

    #[test]
    fn a_constraints_table_keeps_the_templates_it_does_not_name() {
        let config: Config = toml::from_str(
            "[constraints]\ncompiler = \"0.34.0\"\nartifacts = \"contracts/artifacts\"\nself = [\"**/presets/**\"]\n[constraints.overrides]\n\"a.compact\" = \"b.compact\"\n",
        )
        .expect("the snippet is valid config");

        assert_eq!(config.constraints.compiler.as_deref(), Some("0.34.0"));
        assert_eq!(
            config.constraints.artifacts,
            std::path::Path::new("contracts/artifacts")
        );
        assert_eq!(config.constraints.own, ["**/presets/**"]);
        assert_eq!(config.constraints.sources, super::DEFAULT_SOURCES);
        assert_eq!(
            config
                .constraints
                .overrides
                .get("a.compact")
                .map(String::as_str),
            Some("b.compact")
        );
    }

    #[test]
    fn an_unknown_constraints_key_is_rejected() {
        let error = toml::from_str::<Config>("[constraints]\nsorces = []\n")
            .expect_err("the key is misspelled");

        assert!(error.to_string().contains("sorces"), "{error}");
    }

    #[test]
    fn an_unknown_kind_is_rejected() {
        let error =
            toml::from_str::<Config>("[kinds.circiut]\n").expect_err("the kind is misspelled");

        assert!(error.to_string().contains("circiut"), "{error}");
    }

    /// Writes `text` to a `compact.toml` of its own and returns what `load` made of it.
    fn load_document(name: &str, text: &str) -> Result<Config, super::ConfigError> {
        let dir = std::env::temp_dir().join(format!("compact-lint-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("the temp dir is writable");
        let path = dir.join("compact.toml");
        std::fs::write(&path, text).expect("the config is writable");

        let loaded = Config::load(&path);

        std::fs::remove_dir_all(&dir).expect("the temp dir is removable");
        loaded
    }

    #[test]
    fn tables_another_tool_owns_are_ignored() {
        let config = load_document(
            "foreign",
            "[profile]\ndefault_network = \"local\"\n\n[lint]\ninclude = [\"src/**/*.compact\"]\n",
        )
        .expect("the deployer's tables are not the linter's business");

        assert_eq!(config.include, ["src/**/*.compact"]);
    }

    #[test]
    fn a_file_without_a_lint_table_is_an_error() {
        let error = load_document("no-lint", "[profile]\ndefault_network = \"local\"\n")
            .expect_err("the file carries no [lint] table");

        assert!(error.to_string().contains("has no [lint] table"), "{error}");
    }

    #[test]
    fn a_typo_under_the_lint_table_is_still_rejected() {
        let error = load_document("lint-typo", "[lint]\ninclued = []\n")
            .expect_err("the key is misspelled");
        let source = std::error::Error::source(&error).expect("the parser named the key");

        assert!(source.to_string().contains("inclued"), "{source}");
    }
}
