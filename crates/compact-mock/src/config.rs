//! The `[mock]` table of `compact.toml`: discovery, the model, structural validation,
//! rule precedence, and the lexical path arithmetic every emitted path goes through.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Unexpected, Visitor};

use crate::error::{ConfigError, Error};
use crate::params::is_name;

pub const CONFIG_FILE_NAME: &str = "compact.toml";

/// The table this crate owns. Every other table of the file is ignored.
pub const MOCK_TABLE: &str = "mock";

/// The authenticator that keeps the caller a circuit argument.
pub const CALLER: &str = "caller";

const DEFAULT_SRC: &str = "src";
const DEFAULT_TEST_DIR: &str = "{dir}/test";
const DIR_PLACEHOLDER: &str = "{dir}/";
const DEFAULT_NAME: &str = "Mock{module}{instance}{suffix}";
const DEFAULT_INIT_CIRCUIT: &str = "initialize";
const SALT_PLACEHOLDER: &str = "{salt}";

/// Keys a `[[mock.rules]]` table owns. An authenticator may not take one as its name.
pub const RULE_KEYS: [&str; 21] = [
    "modules",
    "exclude_modules",
    "auth",
    "inject",
    "name",
    "prefix",
    "salt",
    "init",
    "module_args",
    "circuit_args",
    "exclude",
    "disclose",
    "guard",
    "rename",
    "ledger",
    "ledger_names",
    "include",
    "implements",
    "instances",
    "merge",
    "group",
];

/// Keys an instance table may set.
pub const INSTANCE_KEYS: [&str; 9] = [
    "suffix",
    "group",
    "prefix",
    "salt",
    "init",
    "module_args",
    "circuit_args",
    "exclude",
    "rename",
];

/// The config after structural validation. Paths are absolute and normalized.
#[derive(Clone, Debug)]
pub struct Config {
    pub path: PathBuf,
    /// The config path as messages print it.
    pub shown: String,
    pub src: PathBuf,
    /// `test_dir` after `{dir}/`, as `/`-separated segments.
    pub test_tail: Vec<String>,
    pub spdx: Option<String>,
    pub caller_type: Option<TypeRef>,
    pub exclude: Globs,
    /// Every authenticator by name, the built-in `caller` included.
    pub auths: BTreeMap<String, AuthSpec>,
    pub injectors: BTreeMap<String, InjectSpec>,
    pub rules: Vec<Rule>,
}

impl Config {
    /// The file of `module` (relative to `src`, without `.compact`).
    #[must_use]
    pub fn module_file(&self, module: &str) -> PathBuf {
        normalize(&self.src.join(format!("{module}.compact")))
    }

    /// The test directory of a module.
    #[must_use]
    pub fn test_dir(&self, module: &str) -> PathBuf {
        let mut dir = self.src.join(module_dir(module));
        for segment in &self.test_tail {
            dir.push(segment);
        }
        normalize(&dir)
    }

    /// The artifacts directory a module's mocks are written to.
    #[must_use]
    pub fn artifacts_dir(&self, module: &str) -> PathBuf {
        self.test_dir(module).join("artifacts")
    }

    /// The rules that apply to `module`, in file order.
    #[must_use]
    pub fn applicable(&self, module: &str) -> Vec<usize> {
        self.rules
            .iter()
            .enumerate()
            .filter(|(_, rule)| rule.applies(module))
            .map(|(index, _)| index)
            .collect()
    }
}

/// The directory part of a module path; empty at the root.
#[must_use]
pub fn module_dir(module: &str) -> &str {
    module.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// The file stem of a module path.
#[must_use]
pub fn module_stem(module: &str) -> &str {
    module.rsplit('/').next().unwrap_or(module)
}

/// A compiled glob list with its source patterns.
#[derive(Clone, Debug, Default)]
pub struct Globs {
    pub patterns: Vec<String>,
    set: GlobSet,
}

impl Globs {
    #[must_use]
    pub fn matches(&self, module: &str) -> bool {
        self.set.is_match(module)
    }

    /// The indices of the patterns that match `module`.
    #[must_use]
    pub fn matching(&self, module: &str) -> Vec<usize> {
        self.set.matches(module)
    }

    fn build(patterns: Vec<String>) -> Result<Self, (String, globset::Error)> {
        let mut builder = GlobSetBuilder::new();
        for pattern in &patterns {
            let glob = GlobBuilder::new(pattern)
                .literal_separator(true)
                .build()
                .map_err(|error| (pattern.clone(), error))?;
            builder.add(glob);
        }
        let set = builder.build().map_err(|error| (String::new(), error))?;
        Ok(Self { patterns, set })
    }
}

/// A type named by its declaring module: `caller_type`, an injector's `type`, an
/// `implements` entry.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypeRef {
    pub name: String,
    pub module: String,
}

/// One authenticator. The built-in `caller` has no module and no call.
#[derive(Clone, Debug)]
pub struct AuthSpec {
    pub name: String,
    pub module: Option<String>,
    pub call: Option<String>,
    pub prefix: Option<String>,
    pub suffix: String,
    /// The caller-typed parameters the call replaces, by name.
    pub params: Vec<String>,
}

impl AuthSpec {
    /// Whether this is the built-in `caller`, which injects nothing.
    #[must_use]
    pub fn is_caller(&self) -> bool {
        self.name == CALLER
    }

    /// The salt slot of `call`, if it takes a salt.
    #[must_use]
    pub fn slot(&self) -> Option<SaltSlot> {
        self.call
            .as_deref()
            .and_then(|call| salt_slot(call).ok().flatten())
    }
}

/// Where `{salt}` sits in an authenticator call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaltSlot {
    /// Byte range of the whole slot: `pad(<n>, "{salt}")` or `"{salt}"`.
    pub start: usize,
    pub end: usize,
    /// `<n>` for a `pad` slot.
    pub width: Option<usize>,
}

impl SaltSlot {
    /// `call` with the slot filled by a string salt, kept inside its literal.
    #[must_use]
    pub fn fill_text(&self, call: &str, salt: &str) -> String {
        let slot = &call[self.start..self.end];
        let filled = slot.replacen(SALT_PLACEHOLDER, salt, 1);
        format!("{}{filled}{}", &call[..self.start], &call[self.end..])
    }

    /// `call` with the whole slot replaced by an expression.
    #[must_use]
    pub fn fill_expr(&self, call: &str, expr: &str) -> String {
        format!("{}{expr}{}", &call[..self.start], &call[self.end..])
    }
}

/// One injector.
#[derive(Clone, Debug)]
pub struct InjectSpec {
    pub name: String,
    pub module: String,
    pub ty: TypeRef,
    pub call: String,
    pub prefix: Option<String>,
    pub scope: Scope,
    /// The parameters of `ty` the call replaces, by name.
    pub params: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Caller,
    All,
}

/// One `[[mock.rules]]` table.
#[derive(Clone, Debug)]
pub struct Rule {
    /// 1-based position among the rules, as messages print it.
    pub number: usize,
    pub modules: Globs,
    pub exclude_modules: Globs,
    pub auth: Option<Vec<String>>,
    pub name: Option<String>,
    pub prefix: Option<String>,
    pub module_args: Option<Vec<String>>,
    pub circuit_args: Option<BTreeMap<String, Vec<String>>>,
    pub instances: Option<Vec<Instance>>,
    pub merge: Option<bool>,
    /// The keys a per-authenticator table may replace, as the rule sets them.
    pub settings: Settings,
    /// Per-authenticator tables, by authenticator name.
    pub overrides: BTreeMap<String, Settings>,
}

impl Rule {
    #[must_use]
    pub fn applies(&self, module: &str) -> bool {
        self.modules.matches(module) && !self.exclude_modules.matches(module)
    }

    /// Whether the rule applies to `module` and lists its exact path, not only a glob.
    #[must_use]
    pub fn names(&self, module: &str) -> bool {
        self.applies(module)
            && self
                .modules
                .patterns
                .iter()
                .any(|pattern| pattern == module)
    }
}

/// The keys a per-authenticator table may set.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub inject: Option<Vec<String>>,
    pub salt: Option<Salt>,
    pub init: Option<Init>,
    pub exclude: Option<Vec<String>>,
    pub disclose: Option<Vec<String>>,
    pub guard: Option<Guard>,
    pub rename: Option<BTreeMap<String, String>>,
    pub ledger: Option<Ledger>,
    pub ledger_names: Option<LedgerNames>,
    pub include: Option<Include>,
    pub implements: Option<Vec<TypeRef>>,
}

impl Settings {
    /// `self`'s keys where set, `base`'s otherwise. Lists and tables replace whole.
    #[must_use]
    pub fn over(&self, base: &Self) -> Self {
        Self {
            inject: self.inject.clone().or_else(|| base.inject.clone()),
            salt: self.salt.clone().or_else(|| base.salt.clone()),
            init: self.init.clone().or_else(|| base.init.clone()),
            exclude: self.exclude.clone().or_else(|| base.exclude.clone()),
            disclose: self.disclose.clone().or_else(|| base.disclose.clone()),
            guard: self.guard.clone().or_else(|| base.guard.clone()),
            rename: self.rename.clone().or_else(|| base.rename.clone()),
            ledger: self.ledger.clone().or_else(|| base.ledger.clone()),
            ledger_names: self.ledger_names.or(base.ledger_names),
            include: self.include.clone().or_else(|| base.include.clone()),
            implements: self.implements.clone().or_else(|| base.implements.clone()),
        }
    }
}

/// One instance table.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Instance {
    pub suffix: String,
    pub group: Option<String>,
    pub prefix: Option<String>,
    pub salt: Option<Salt>,
    pub init: Option<Init>,
    pub module_args: Option<Vec<String>>,
    pub circuit_args: Option<BTreeMap<String, Vec<String>>>,
    pub exclude: Option<Vec<String>>,
    pub rename: Option<BTreeMap<String, String>>,
}

/// `salt`: text inside the slot's literal, an exported ledger field, or an expression.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Salt {
    Text(String),
    Ledger(String),
    Expr(String),
}

impl<'de> Deserialize<'de> for Salt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct SaltVisitor;

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SaltTable {
            ledger: Option<String>,
            expr: Option<String>,
        }

        impl<'de> Visitor<'de> for SaltVisitor {
            type Value = Salt;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter
                    .write_str("a string, { ledger = \"<field>\" } or { expr = \"<expression>\" }")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Salt, E> {
                Ok(Salt::Text(value.to_owned()))
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Salt, A::Error> {
                let table = SaltTable::deserialize(de::value::MapAccessDeserializer::new(map))?;
                match (table.ledger, table.expr) {
                    (Some(field), None) => Ok(Salt::Ledger(field)),
                    (None, Some(expr)) => Ok(Salt::Expr(expr)),
                    _ => Err(de::Error::custom(
                        "salt table needs exactly one of ledger and expr",
                    )),
                }
            }
        }

        deserializer.deserialize_any(SaltVisitor)
    }
}

/// The constructor shape, as configured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Init {
    Auto,
    None,
    Plain,
    Table {
        flag: Option<String>,
        circuit: Option<String>,
    },
}

impl Init {
    /// The init circuit this shape calls.
    #[must_use]
    pub fn circuit(&self) -> &str {
        match self {
            Self::Table {
                circuit: Some(circuit),
                ..
            } => circuit,
            _ => DEFAULT_INIT_CIRCUIT,
        }
    }

    /// The flag gating the call, if any.
    #[must_use]
    pub fn flag(&self) -> Option<&str> {
        match self {
            Self::Table { flag, .. } => flag.as_deref(),
            _ => None,
        }
    }

    /// Whether the shape asks for a constructor explicitly (not `auto`, not `none`).
    #[must_use]
    pub const fn explicit(&self) -> bool {
        matches!(self, Self::Plain | Self::Table { .. })
    }
}

impl fmt::Display for Init {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Auto => formatter.write_str("\"auto\""),
            Self::None => formatter.write_str("\"none\""),
            Self::Plain => formatter.write_str("\"plain\""),
            Self::Table { flag, circuit } => {
                let mut parts = Vec::new();
                if let Some(flag) = flag {
                    parts.push(format!("flag = \"{flag}\""));
                }
                if let Some(circuit) = circuit {
                    parts.push(format!("circuit = \"{circuit}\""));
                }
                write!(formatter, "{{ {} }}", parts.join(", "))
            }
        }
    }
}

impl<'de> Deserialize<'de> for Init {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InitVisitor;

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct InitTable {
            flag: Option<String>,
            circuit: Option<String>,
        }

        impl<'de> Visitor<'de> for InitVisitor {
            type Value = Init;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("\"auto\", \"none\", \"plain\" or { flag, circuit }")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Init, E> {
                match value {
                    "auto" => Ok(Init::Auto),
                    "none" => Ok(Init::None),
                    "plain" => Ok(Init::Plain),
                    other => Err(E::invalid_value(Unexpected::Str(other), &self)),
                }
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Init, A::Error> {
                let table = InitTable::deserialize(de::value::MapAccessDeserializer::new(map))?;
                Ok(Init::Table {
                    flag: table.flag,
                    circuit: table.circuit,
                })
            }
        }

        deserializer.deserialize_any(InitVisitor)
    }
}

/// `guard`: every exposed circuit, or the ones named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Guard {
    All(bool),
    Some(Vec<String>),
}

impl<'de> Deserialize<'de> for Guard {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        bool_or_list(deserializer, "a boolean or a list of circuit names")
            .map(|value| value.map_or_else(Guard::Some, Guard::All))
    }
}

/// `ledger`: all exported fields, none, or the ones named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ledger {
    All(bool),
    Some(Vec<String>),
}

impl<'de> Deserialize<'de> for Ledger {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        bool_or_list(deserializer, "a boolean or a list of ledger field names")
            .map(|value| value.map_or_else(Ledger::Some, Ledger::All))
    }
}

/// A boolean as `Ok(Ok(bool))`, a string list as `Ok(Err(list))`.
fn bool_or_list<'de, D: Deserializer<'de>>(
    deserializer: D,
    expecting: &'static str,
) -> Result<Result<bool, Vec<String>>, D::Error> {
    struct BoolOrList(&'static str);

    impl<'de> Visitor<'de> for BoolOrList {
        type Value = Result<bool, Vec<String>>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }

        fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
            Ok(Ok(value))
        }

        fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
            Vec::<String>::deserialize(de::value::SeqAccessDeserializer::new(seq)).map(Err)
        }
    }

    deserializer.deserialize_any(BoolOrList(expecting))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerNames {
    #[default]
    Prefixed,
    Plain,
}

/// `include`: the conventional fragment when it exists, never, or a file under `test_dir`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Include {
    Default(bool),
    File(String),
}

impl<'de> Deserialize<'de> for Include {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct IncludeVisitor;

        impl Visitor<'_> for IncludeVisitor {
            type Value = Include;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a boolean or a fragment file name")
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Include, E> {
                Ok(Include::Default(value))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Include, E> {
                Ok(Include::File(value.to_owned()))
            }
        }

        deserializer.deserialize_any(IncludeVisitor)
    }
}

#[derive(Debug, Deserialize)]
struct RawFile {
    mock: Option<toml::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMock {
    src: Option<String>,
    test_dir: Option<String>,
    spdx: Option<String>,
    caller_type: Option<TypeRef>,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    auth: BTreeMap<String, RawAuth>,
    #[serde(default)]
    inject: BTreeMap<String, RawInject>,
    #[serde(default)]
    rules: Vec<toml::Table>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAuth {
    module: Option<String>,
    call: Option<String>,
    prefix: Option<String>,
    suffix: Option<String>,
    params: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawInject {
    module: String,
    #[serde(rename = "type")]
    ty: TypeRef,
    call: String,
    prefix: Option<String>,
    #[serde(default)]
    scope: Scope,
    params: Option<Vec<String>>,
}

/// The rule-only keys; the per-authenticator ones are read into [`Settings`].
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRuleOnly {
    modules: Option<Vec<String>>,
    #[serde(default)]
    exclude_modules: Vec<String>,
    auth: Option<Vec<String>>,
    name: Option<String>,
    prefix: Option<String>,
    module_args: Option<Vec<String>>,
    circuit_args: Option<BTreeMap<String, Vec<String>>>,
    merge: Option<bool>,
}

/// The per-authenticator keys.
const SETTINGS_KEYS: [&str; 11] = [
    "inject",
    "salt",
    "init",
    "exclude",
    "disclose",
    "guard",
    "rename",
    "ledger",
    "ledger_names",
    "include",
    "implements",
];

/// How paths print: relative to the working directory when under it.
#[derive(Clone, Debug)]
pub struct Paths {
    pub cwd: PathBuf,
}

impl Paths {
    /// `path` as messages and the summary print it.
    #[must_use]
    pub fn show(&self, path: &Path) -> String {
        match path.strip_prefix(&self.cwd) {
            Ok(relative) => posix(relative),
            Err(_) => path.display().to_string(),
        }
    }

    /// `path` made absolute against the working directory, then normalized.
    #[must_use]
    pub fn absolute(&self, path: &Path) -> PathBuf {
        normalize(&self.cwd.join(path))
    }
}

/// Walks up from `start` looking for [`CONFIG_FILE_NAME`].
#[must_use]
pub fn discover(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .map(|directory| directory.join(CONFIG_FILE_NAME))
        .find(|candidate| candidate.is_file())
}

/// Whether the file at `path` parses as TOML and has a top-level `mock` table.
/// # Errors
/// Returns the read or parse error.
pub fn has_mock_table(path: &Path, paths: &Paths) -> Result<bool, ConfigError> {
    let cfg = paths.show(path);
    let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
        cfg: cfg.clone(),
        source,
    })?;
    let table: toml::Table =
        toml::from_str(&text).map_err(|source| ConfigError::Parse { cfg, source })?;
    Ok(matches!(table.get(MOCK_TABLE), Some(toml::Value::Table(_))))
}

#[allow(
    clippy::too_many_lines,
    reason = "the [mock] table validates top to bottom in key order"
)]
/// Reads, parses and structurally validates the `[mock]` table of a config.
/// # Errors
/// Returns every structural error, in file order. A read or parse error, and a missing
/// `[mock]` table, is the only one.
pub fn load(path: &Path, paths: &Paths) -> Result<Config, Vec<Error>> {
    let path = paths.absolute(path);
    let cfg = paths.show(&path);
    let text = std::fs::read_to_string(&path).map_err(|source| {
        vec![Error::from(ConfigError::Read {
            cfg: cfg.clone(),
            source,
        })]
    })?;
    let file: RawFile = toml::from_str(&text).map_err(|source| {
        vec![Error::from(ConfigError::Parse {
            cfg: cfg.clone(),
            source,
        })]
    })?;
    let Some(value @ toml::Value::Table(_)) = file.mock else {
        return Err(vec![ConfigError::NoMockTable { cfg }.into()]);
    };
    let raw = RawMock::deserialize(value).map_err(|source| {
        vec![Error::from(ConfigError::Invalid {
            cfg: cfg.clone(),
            at: "[mock]".to_owned(),
            message: source.message().to_owned(),
        })]
    })?;

    let base = path.parent().map_or_else(PathBuf::new, Path::to_owned);
    let mut errors = Vec::new();
    let mut report = |error: ConfigError| errors.push(Error::from(error));

    let src_text = raw.src.as_deref().unwrap_or(DEFAULT_SRC);
    if is_absolute(src_text) {
        report(ConfigError::SrcAbsolute {
            cfg: cfg.clone(),
            value: src_text.to_owned(),
        });
    }
    let src = normalize(&base.join(src_text));
    if !is_absolute(src_text) && !src.starts_with(&base) {
        report(ConfigError::SrcOutside {
            cfg: cfg.clone(),
            value: src_text.to_owned(),
        });
    } else if !src.is_dir() {
        report(ConfigError::Src {
            cfg: cfg.clone(),
            dir: paths.show(&src),
        });
    }

    let test_dir = raw.test_dir.as_deref().unwrap_or(DEFAULT_TEST_DIR);
    let test_tail = test_tail(test_dir).unwrap_or_else(|| {
        report(ConfigError::TestDir {
            cfg: cfg.clone(),
            value: test_dir.to_owned(),
        });
        Vec::new()
    });

    if let Some(spdx) = &raw.spdx
        && (spdx.is_empty() || spdx.contains(['\n', '\r']))
    {
        report(ConfigError::Spdx { cfg: cfg.clone() });
    }

    if let Some(caller_type) = &raw.caller_type {
        check_module(&caller_type.module, &cfg, &mut report);
        check_name(
            "[mock].caller_type.name",
            &caller_type.name,
            &cfg,
            &mut report,
        );
    }

    let exclude = globs(raw.exclude, "[mock].exclude", &cfg, &mut report);

    let mut auths = BTreeMap::new();
    auths.insert(
        CALLER.to_owned(),
        AuthSpec {
            name: CALLER.to_owned(),
            module: None,
            call: None,
            prefix: None,
            suffix: "Caller".to_owned(),
            params: vec![CALLER.to_owned()],
        },
    );
    for (name, auth) in raw.auth {
        if let Some(spec) = auth_spec(&name, auth, raw.caller_type.is_some(), &cfg, &mut report) {
            auths.insert(name, spec);
        }
    }

    let mut injectors = BTreeMap::new();
    for (name, inject) in raw.inject {
        check_auth_name(&name, &cfg, &mut report);
        check_module(&inject.module, &cfg, &mut report);
        check_module(&inject.ty.module, &cfg, &mut report);
        if let Some(prefix) = &inject.prefix {
            check_name(
                &format!("[mock.inject.{name}].prefix"),
                prefix,
                &cfg,
                &mut report,
            );
        }
        if inject.call.contains('{') {
            report(ConfigError::InjectPlaceholder {
                cfg: cfg.clone(),
                name: name.clone(),
            });
        }
        let params = check_params(
            &format!("[mock.inject.{name}].params"),
            inject.params,
            &name,
            &cfg,
            &mut report,
        );
        injectors.insert(
            name.clone(),
            InjectSpec {
                name,
                module: inject.module,
                ty: inject.ty,
                call: inject.call,
                prefix: inject.prefix,
                scope: inject.scope,
                params,
            },
        );
    }

    if raw.rules.is_empty() {
        report(ConfigError::NoRules { cfg: cfg.clone() });
    }
    let mut rules = Vec::new();
    for (index, table) in raw.rules.into_iter().enumerate() {
        let context = RuleContext {
            number: index + 1,
            cfg: &cfg,
            auths: &auths,
            injectors: &injectors,
        };
        if let Some(rule) = rule(&context, table, &mut report) {
            rules.push(rule);
        }
    }

    if errors.is_empty() {
        Ok(Config {
            path,
            shown: cfg,
            src,
            test_tail,
            spdx: raw.spdx,
            caller_type: raw.caller_type,
            exclude,
            auths,
            injectors,
            rules,
        })
    } else {
        Err(errors)
    }
}

/// The `[mock].test_dir` tail of the config at `path`, its default when unset. `None` when
/// the file does not read or parse, has no `[mock]` table, or the value is malformed.
#[must_use]
pub fn mock_test_tail(path: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(path).ok()?;
    let table: toml::Table = toml::from_str(&text).ok()?;
    let toml::Value::Table(mock) = table.get(MOCK_TABLE)? else {
        return None;
    };
    match mock.get("test_dir") {
        None => test_tail(DEFAULT_TEST_DIR),
        Some(toml::Value::String(template)) => test_tail(template),
        Some(_) => None,
    }
}

/// `test_dir` after `{dir}/`, split into segments, or `None` when the form is wrong.
fn test_tail(template: &str) -> Option<Vec<String>> {
    let rest = template.strip_prefix(DIR_PLACEHOLDER)?;
    if rest.contains(['{', '}', '\\']) || is_absolute(rest) {
        return None;
    }
    let segments: Vec<String> = rest
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .map(str::to_owned)
        .collect();
    if segments.is_empty() || segments.iter().any(|segment| segment == "..") {
        return None;
    }
    Some(segments)
}

fn auth_spec(
    name: &str,
    auth: RawAuth,
    has_caller_type: bool,
    cfg: &str,
    report: &mut impl FnMut(ConfigError),
) -> Option<AuthSpec> {
    if name == CALLER {
        if auth.module.is_some()
            || auth.call.is_some()
            || auth.prefix.is_some()
            || auth.params.is_some()
        {
            report(ConfigError::CallerTable {
                cfg: cfg.to_owned(),
            });
        }
        if let Some(suffix) = &auth.suffix {
            check_suffix(&format!("[mock.auth.{name}].suffix"), suffix, cfg, report);
        }
        return Some(AuthSpec {
            name: CALLER.to_owned(),
            module: None,
            call: None,
            prefix: None,
            suffix: auth.suffix.unwrap_or_else(|| "Caller".to_owned()),
            params: vec![CALLER.to_owned()],
        });
    }
    let params = check_params(
        &format!("[mock.auth.{name}].params"),
        auth.params,
        CALLER,
        cfg,
        report,
    );
    check_auth_name(name, cfg, report);
    let (Some(module), Some(call)) = (auth.module, auth.call) else {
        report(ConfigError::AuthFields {
            cfg: cfg.to_owned(),
            name: name.to_owned(),
        });
        return None;
    };
    check_module(&module, cfg, report);
    if let Some(prefix) = &auth.prefix {
        check_name(&format!("[mock.auth.{name}].prefix"), prefix, cfg, report);
    }
    if let Some(suffix) = &auth.suffix {
        check_suffix(&format!("[mock.auth.{name}].suffix"), suffix, cfg, report);
    }
    if salt_slot(&call).is_err() {
        report(ConfigError::SaltSlot {
            cfg: cfg.to_owned(),
            name: name.to_owned(),
        });
    }
    if !has_caller_type {
        report(ConfigError::AuthNeedsCallerType {
            cfg: cfg.to_owned(),
            name: name.to_owned(),
        });
    }
    Some(AuthSpec {
        name: name.to_owned(),
        module: Some(module),
        call: Some(call),
        prefix: auth.prefix,
        suffix: auth.suffix.unwrap_or_default(),
        params,
    })
}

/// `params`, or `[default]` when unset. Each entry must be an identifier, and the list
/// must not be empty.
fn check_params(
    key: &str,
    params: Option<Vec<String>>,
    default: &str,
    cfg: &str,
    report: &mut impl FnMut(ConfigError),
) -> Vec<String> {
    let Some(params) = params else {
        return vec![default.to_owned()];
    };
    if params.is_empty() {
        report(ConfigError::Invalid {
            cfg: cfg.to_owned(),
            at: key.to_owned(),
            message: "names no parameter".to_owned(),
        });
    }
    for param in &params {
        check_name(key, param, cfg, report);
    }
    params
}

/// Authenticator and injector names: `[a-z][a-z0-9_]*`, never a rule key.
fn check_auth_name(name: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    let shaped = name.starts_with(|ch: char| ch.is_ascii_lowercase())
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if RULE_KEYS.contains(&name) || SETTINGS_KEYS.contains(&name) {
        report(ConfigError::AuthNameIsRuleKey {
            cfg: cfg.to_owned(),
            name: name.to_owned(),
        });
    } else if !shaped {
        report(ConfigError::AuthName {
            cfg: cfg.to_owned(),
            name: name.to_owned(),
        });
    }
}

struct RuleContext<'a> {
    number: usize,
    cfg: &'a str,
    auths: &'a BTreeMap<String, AuthSpec>,
    injectors: &'a BTreeMap<String, InjectSpec>,
}

impl RuleContext<'_> {
    fn at(&self) -> String {
        format!("[[mock.rules]] #{}", self.number)
    }

    fn invalid(&self, at: String, error: &toml::de::Error) -> ConfigError {
        ConfigError::Invalid {
            cfg: self.cfg.to_owned(),
            at,
            message: error.message().to_owned(),
        }
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "the rule table splits and checks in key order"
)]
fn rule(
    context: &RuleContext<'_>,
    table: toml::Table,
    report: &mut impl FnMut(ConfigError),
) -> Option<Rule> {
    let cfg = context.cfg;
    let number = context.number;
    let mut rule_only = toml::Table::new();
    let mut settings_table = toml::Table::new();
    let mut override_tables: BTreeMap<String, toml::Value> = BTreeMap::new();
    let mut instance_values: Option<toml::Value> = None;
    for (key, value) in table {
        if key == "instances" {
            instance_values = Some(value);
        } else if SETTINGS_KEYS.contains(&key.as_str()) {
            settings_table.insert(key, value);
        } else if RULE_KEYS.contains(&key.as_str()) && key != "group" {
            rule_only.insert(key, value);
        } else if context.auths.contains_key(&key) {
            override_tables.insert(key, value);
        } else {
            report(ConfigError::UnknownRuleKey {
                cfg: cfg.to_owned(),
                number,
                key,
            });
        }
    }

    let only = match RawRuleOnly::deserialize(toml::Value::Table(rule_only)) {
        Ok(only) => only,
        Err(error) => {
            report(context.invalid(context.at(), &error));
            return None;
        }
    };
    let settings = match Settings::deserialize(toml::Value::Table(settings_table)) {
        Ok(settings) => settings,
        Err(error) => {
            report(context.invalid(context.at(), &error));
            return None;
        }
    };
    let mut overrides = BTreeMap::new();
    for (name, value) in override_tables {
        match Settings::deserialize(value) {
            Ok(table) => {
                overrides.insert(name, table);
            }
            Err(error) => report(context.invalid(format!("{}: {name}", context.at()), &error)),
        }
    }
    let instances = match instance_values {
        Some(value) => Some(instances(context, value, report)?),
        None => None,
    };

    let Some(module_globs) = only.modules else {
        report(ConfigError::RuleModules {
            cfg: cfg.to_owned(),
            number,
        });
        return None;
    };
    let modules = rule_globs(module_globs, number, cfg, report);
    let exclude_modules = rule_globs(only.exclude_modules, number, cfg, report);

    if let Some(name) = &only.name {
        check_template(name, number, cfg, report);
    }
    if let Some(prefix) = &only.prefix {
        check_name(&format!("{}: prefix", context.at()), prefix, cfg, report);
    }
    for auth in only.auth.iter().flatten() {
        if !context.auths.contains_key(auth) {
            report(ConfigError::AuthUndefined {
                cfg: cfg.to_owned(),
                number,
                name: auth.clone(),
            });
        }
    }
    if only.merge == Some(true) && instances.is_none() {
        report(ConfigError::MergeNeedsInstances {
            cfg: cfg.to_owned(),
            number,
        });
    }

    check_settings(context, &settings, None, report);
    for (name, table) in &overrides {
        check_settings(context, table, Some(name), report);
    }
    for instance in instances.iter().flatten() {
        let label = format!("{}: instance \"{}\"", context.at(), instance.suffix);
        if let Some(prefix) = &instance.prefix {
            check_name(&format!("{label}: prefix"), prefix, cfg, report);
        }
        if let Some(init) = &instance.init {
            check_init(&label, init, cfg, report);
        }
        for (old, new) in instance.rename.iter().flatten() {
            check_name(&format!("{label}: rename.{old}"), new, cfg, report);
        }
        if let Some(Salt::Expr(expr)) = &instance.salt {
            check_expr(&label, expr, cfg, report);
        }
    }

    let merged = only.merge == Some(true)
        || instances
            .iter()
            .flatten()
            .any(|instance| instance.group.is_some());
    let plain = settings.ledger_names == Some(LedgerNames::Plain)
        || overrides
            .values()
            .any(|table| table.ledger_names == Some(LedgerNames::Plain));
    if merged && plain {
        report(ConfigError::PlainWithMerge {
            cfg: cfg.to_owned(),
            number,
        });
    }

    Some(Rule {
        number,
        modules,
        exclude_modules,
        auth: only.auth,
        name: only.name,
        prefix: only.prefix,
        module_args: only.module_args,
        circuit_args: only.circuit_args,
        instances,
        merge: only.merge,
        settings,
        overrides,
    })
}

fn instances(
    context: &RuleContext<'_>,
    value: toml::Value,
    report: &mut impl FnMut(ConfigError),
) -> Option<Vec<Instance>> {
    let toml::Value::Array(values) = value else {
        report(ConfigError::Invalid {
            cfg: context.cfg.to_owned(),
            at: format!("{}: instances", context.at()),
            message: "expected an array of tables".to_owned(),
        });
        return None;
    };
    let mut found: Vec<Instance> = Vec::new();
    let mut failed = false;
    for value in values {
        let toml::Value::Table(table) = value else {
            report(ConfigError::Invalid {
                cfg: context.cfg.to_owned(),
                at: format!("{}: instances", context.at()),
                message: "expected an array of tables".to_owned(),
            });
            failed = true;
            continue;
        };
        let suffix = table
            .get("suffix")
            .and_then(toml::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let mut kept = toml::Table::new();
        for (key, value) in table {
            if INSTANCE_KEYS.contains(&key.as_str()) {
                kept.insert(key, value);
            } else {
                report(ConfigError::InstanceKey {
                    cfg: context.cfg.to_owned(),
                    number: context.number,
                    suffix: suffix.clone(),
                    key,
                });
                failed = true;
            }
        }
        match Instance::deserialize(toml::Value::Table(kept)) {
            Ok(instance) => {
                check_suffix(
                    &format!("{}: instance suffix", context.at()),
                    &instance.suffix,
                    context.cfg,
                    report,
                );
                if let Some(group) = &instance.group
                    && (group.is_empty() || !is_suffix(group))
                {
                    check_suffix(
                        &format!("{}: instance group", context.at()),
                        &format!("{group}-"),
                        context.cfg,
                        report,
                    );
                }
                if found.iter().any(|other| other.suffix == instance.suffix) {
                    report(ConfigError::SuffixTwice {
                        cfg: context.cfg.to_owned(),
                        number: context.number,
                        suffix: instance.suffix.clone(),
                    });
                }
                found.push(instance);
            }
            Err(error) => {
                report(context.invalid(format!("{}: instance \"{suffix}\"", context.at()), &error));
                failed = true;
            }
        }
    }
    (!failed).then_some(found)
}

/// Checks the per-authenticator keys of a rule or of one of its authenticator tables.
fn check_settings(
    context: &RuleContext<'_>,
    settings: &Settings,
    auth: Option<&String>,
    report: &mut impl FnMut(ConfigError),
) {
    let cfg = context.cfg;
    let number = context.number;
    let label = match auth {
        Some(name) => format!("{}: {name}", context.at()),
        None => context.at(),
    };
    if let Some(init) = &settings.init {
        check_init(&label, init, cfg, report);
    }
    for (old, new) in settings.rename.iter().flatten() {
        check_name(&format!("{label}: rename.{old}"), new, cfg, report);
    }
    if let Some(Salt::Expr(expr)) = &settings.salt {
        check_expr(&label, expr, cfg, report);
    }
    for implements in settings.implements.iter().flatten() {
        check_module(&implements.module, cfg, report);
        check_name(
            &format!("{label}: implements.name"),
            &implements.name,
            cfg,
            report,
        );
    }
    if let Some(include) = &settings.include
        && let Include::File(file) = include
        && (!file.ends_with(FRAGMENT_SUFFIX) || is_absolute(file) || file.contains(".."))
    {
        report(ConfigError::IncludeFile {
            cfg: cfg.to_owned(),
            number,
            value: file.clone(),
        });
    }
    if let Some(inject) = &settings.inject {
        let mut types: Vec<(&TypeRef, &str)> = Vec::new();
        for name in inject {
            match context.injectors.get(name) {
                Some(spec) => {
                    if let Some((_, first)) = types.iter().find(|(ty, _)| **ty == spec.ty) {
                        report(ConfigError::InjectorsOneType {
                            cfg: cfg.to_owned(),
                            number,
                            first: (*first).to_owned(),
                            second: name.clone(),
                            ty: spec.ty.name.clone(),
                        });
                    }
                    types.push((&spec.ty, name));
                }
                None => report(ConfigError::InjectUndefined {
                    cfg: cfg.to_owned(),
                    number,
                    name: name.clone(),
                }),
            }
        }
    }
    if let (Some(name), Some(_)) = (auth, &settings.salt) {
        if name == CALLER {
            report(ConfigError::CallerSalt {
                cfg: cfg.to_owned(),
                number,
            });
        } else if context
            .auths
            .get(name)
            .is_some_and(|spec| spec.slot().is_none())
        {
            report(ConfigError::NoSaltSlot {
                cfg: cfg.to_owned(),
                number,
                name: name.clone(),
            });
        }
    }
}

fn check_init(label: &str, init: &Init, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    if let Init::Table { flag, circuit } = init {
        if let Some(flag) = flag {
            check_name(&format!("{label}: init.flag"), flag, cfg, report);
        }
        if let Some(circuit) = circuit {
            check_name(&format!("{label}: init.circuit"), circuit, cfg, report);
        }
    }
}

fn check_expr(label: &str, expr: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    if expr.trim().is_empty() || expr.contains(['\n', '\r']) {
        report(ConfigError::SaltExpr {
            cfg: cfg.to_owned(),
            at: label.to_owned(),
        });
    }
}

/// The placeholders a name template may use.
const NAME_PLACEHOLDERS: [&str; 4] = ["module", "instance", "suffix", "dir"];

fn check_template(template: &str, number: usize, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let (inner, next) = match after.find('}') {
            Some(close) => (&after[..close], &after[close + 1..]),
            None => (after, ""),
        };
        if !NAME_PLACEHOLDERS.contains(&inner) || next.is_empty() && after.find('}').is_none() {
            report(ConfigError::NamePlaceholder {
                cfg: cfg.to_owned(),
                number,
                value: template.to_owned(),
                placeholder: inner.to_owned(),
            });
            return;
        }
        rest = next;
    }
}

fn globs(
    patterns: Vec<String>,
    at: &str,
    cfg: &str,
    report: &mut impl FnMut(ConfigError),
) -> Globs {
    match Globs::build(patterns) {
        Ok(globs) => globs,
        Err((pattern, source)) => {
            report(ConfigError::Glob {
                cfg: cfg.to_owned(),
                at: at.to_owned(),
                pattern,
                source,
            });
            Globs::default()
        }
    }
}

fn rule_globs(
    patterns: Vec<String>,
    number: usize,
    cfg: &str,
    report: &mut impl FnMut(ConfigError),
) -> Globs {
    globs(patterns, &format!("[[mock.rules]] #{number}"), cfg, report)
}

pub(crate) const FRAGMENT_SUFFIX: &str = ".fragment.compact";

fn check_name(key: &str, value: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    if !is_name(value) {
        report(ConfigError::Identifier {
            cfg: cfg.to_owned(),
            key: key.to_owned(),
            value: value.to_owned(),
        });
    }
}

/// A suffix is `[A-Za-z0-9_]*`.
fn is_suffix(text: &str) -> bool {
    text.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn check_suffix(key: &str, value: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    if !is_suffix(value) {
        report(ConfigError::Suffix {
            cfg: cfg.to_owned(),
            key: key.to_owned(),
            value: value.to_owned(),
        });
    }
}

fn check_module(module: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    let well_formed = !module.starts_with('/')
        && !module.contains('\\')
        && !module.ends_with(".compact")
        && module
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."));
    if !well_formed {
        report(ConfigError::Module {
            cfg: cfg.to_owned(),
            module: module.to_owned(),
        });
    }
}

/// Whether `path` is absolute, or rooted without a drive.
#[must_use]
pub fn is_absolute(path: &str) -> bool {
    let path = Path::new(path);
    path.is_absolute() || path.has_root()
}

/// Finds the salt slot of an authenticator call.
///
/// `Ok(None)`: no `{salt}`. `Ok(Some)`: exactly one, as `pad(<n>, "{salt}")` or as
/// `"{salt}"`. `Err`: any other placement.
pub(crate) fn salt_slot(call: &str) -> Result<Option<SaltSlot>, ()> {
    let count = call.matches(SALT_PLACEHOLDER).count();
    if count == 0 {
        return Ok(None);
    }
    if count > 1 {
        return Err(());
    }
    let at = call.find(SALT_PLACEHOLDER).ok_or(())?;
    let end = at + SALT_PLACEHOLDER.len();
    // The placeholder must be the whole content of a "..." literal.
    if !call[..at].ends_with('"') || !call[end..].starts_with('"') {
        return Err(());
    }
    let open = at - 1;
    let close = end + 1;
    let before = call[..open].trim_end();
    let after = call[close..].trim_start();
    if let Some(head) = before.strip_suffix(',')
        && let Some(tail) = after.strip_prefix(')')
    {
        let head = head.trim_end();
        let digits_start = head
            .rfind(|ch: char| !ch.is_ascii_digit())
            .map_or(0, |index| index + 1);
        let digits = &head[digits_start..];
        let lead = head[..digits_start].trim_end();
        if !digits.is_empty()
            && let Some(start) = lead
                .strip_suffix('(')
                .and_then(|rest| rest.strip_suffix("pad"))
        {
            let start = start.len();
            let width = digits.parse::<usize>().map_err(|_| ())?;
            let end = call.len() - tail.len();
            return Ok(Some(SaltSlot {
                start,
                end,
                width: Some(width),
            }));
        }
    }
    Ok(Some(SaltSlot {
        start: open,
        end: close,
        width: None,
    }))
}

/// Resolves `.` and `..` lexically. A relative path keeps the `..` it cannot resolve.
#[must_use]
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The path from directory `from` to `to`, both absolute and normalized.
#[must_use]
pub fn relative(from: &Path, to: &Path) -> PathBuf {
    let from: Vec<Component<'_>> = from.components().collect();
    let to: Vec<Component<'_>> = to.components().collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let mut out = PathBuf::new();
    for _ in common..from.len() {
        out.push("..");
    }
    for component in &to[common..] {
        out.push(component.as_os_str());
    }
    out
}

/// `path` with `/` separators; `.` when empty.
#[must_use]
pub fn posix(path: &Path) -> String {
    let parts: Vec<String> = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    }
}

/// An import or include path from directory `from` to file `to`, without `.compact`.
#[must_use]
pub fn import_path(from: &Path, to: &Path) -> String {
    let spelled = posix(&relative(from, to));
    let spelled = spelled.strip_suffix(".compact").unwrap_or(&spelled);
    if spelled.starts_with('.') {
        spelled.to_owned()
    } else {
        format!("./{spelled}")
    }
}

/// The rule-level keys after folding the applicable rules in file order.
#[derive(Clone, Debug)]
pub struct Folded {
    pub auth: Vec<String>,
    pub name: String,
    pub prefix: Option<String>,
    pub module_args: Vec<String>,
    pub circuit_args: BTreeMap<String, Vec<String>>,
    pub instances: Option<Vec<Instance>>,
    pub merge: bool,
    /// The number of the rule that set `instances` or `merge` last, for messages.
    pub instances_rule: usize,
    pub settings: Settings,
}

/// Folds the rules at `indices` (file order): a later rule replaces only the keys it sets.
#[must_use]
pub fn fold(config: &Config, indices: &[usize]) -> Folded {
    let mut folded = Folded {
        auth: vec![CALLER.to_owned()],
        name: DEFAULT_NAME.to_owned(),
        prefix: None,
        module_args: Vec::new(),
        circuit_args: BTreeMap::new(),
        instances: None,
        merge: false,
        instances_rule: 0,
        settings: Settings::default(),
    };
    for &index in indices {
        let rule = &config.rules[index];
        if let Some(auth) = &rule.auth {
            folded.auth.clone_from(auth);
        }
        if let Some(name) = &rule.name {
            folded.name.clone_from(name);
        }
        if rule.prefix.is_some() {
            folded.prefix.clone_from(&rule.prefix);
        }
        if let Some(args) = &rule.module_args {
            folded.module_args.clone_from(args);
        }
        if let Some(args) = &rule.circuit_args {
            folded.circuit_args.clone_from(args);
        }
        if rule.instances.is_some() {
            folded.instances.clone_from(&rule.instances);
            folded.instances_rule = rule.number;
        }
        if let Some(merge) = rule.merge {
            folded.merge = merge;
            folded.instances_rule = rule.number;
        }
        folded.settings = rule.settings.over(&folded.settings);
    }
    folded
}

/// The per-authenticator settings for `auth`: the folded rule keys, then that
/// authenticator's tables of the applicable rules in file order.
#[must_use]
pub fn settings_for(config: &Config, indices: &[usize], base: &Settings, auth: &str) -> Settings {
    let mut settings = base.clone();
    for &index in indices {
        if let Some(table) = config.rules[index].overrides.get(auth) {
            settings = table.over(&settings);
        }
    }
    settings
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        CONFIG_FILE_NAME, Guard, Include, Init, Ledger, Paths, Salt, SaltSlot, Settings, discover,
        fold, has_mock_table, import_path, load, normalize, salt_slot, settings_for, test_tail,
    };

    const AUTH: &str = "caller_type = { name = \"C\", module = \"a/C\" }\n\
                        [mock.auth.prf]\nmodule = \"a/A\"\ncall = 'f(pad(32, \"{salt}\"))'\n";

    fn write(snippet: &str) -> (tempfile::TempDir, Paths) {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        std::fs::create_dir(directory.path().join("src")).expect("src is created");
        std::fs::write(directory.path().join(CONFIG_FILE_NAME), snippet).expect("written");
        let paths = Paths {
            cwd: directory.path().to_owned(),
        };
        (directory, paths)
    }

    fn rejection(snippet: &str) -> Vec<String> {
        let (directory, paths) = write(snippet);
        match load(&directory.path().join(CONFIG_FILE_NAME), &paths) {
            Ok(_) => Vec::new(),
            Err(errors) => errors
                .iter()
                .map(|error| {
                    let text = error.to_string();
                    match std::error::Error::source(error) {
                        Some(source) => format!("{text} | {source}"),
                        None => text,
                    }
                })
                .collect(),
        }
    }

    fn mock(body: &str) -> String {
        format!("[mock]\n{body}")
    }

    const RULE: &str = "[[mock.rules]]\nmodules = [\"**\"]\n";

    #[test]
    fn the_example_config_validates() {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        std::fs::create_dir_all(directory.path().join("contracts/src")).expect("src");
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/compact.toml");
        let path = directory.path().join(CONFIG_FILE_NAME);
        std::fs::copy(example, &path).expect("copied");
        let paths = Paths {
            cwd: directory.path().to_owned(),
        };
        let config = load(&path, &paths).unwrap_or_else(|errors| panic!("{errors:?}"));
        assert_eq!(config.rules.len(), 27);
        assert!(config.auths.contains_key("prf") && config.injectors.contains_key("blinding"));
    }

    #[test]
    fn a_minimal_table_is_accepted() {
        assert!(rejection(&mock(RULE)).is_empty());
    }

    #[test]
    fn a_file_without_a_mock_table_is_rejected() {
        assert_eq!(
            rejection("[lint]\nx = 1\n"),
            [format!("config {CONFIG_FILE_NAME} has no [mock] table")]
        );
        assert_eq!(
            rejection("mock = 1\n"),
            [format!("config {CONFIG_FILE_NAME} has no [mock] table")]
        );
    }

    #[test]
    fn other_tables_are_never_read() {
        assert!(
            rejection(&format!(
                "[lint]\nbogus = {{ x = 1 }}\n[profile]\ny = 2\n{}",
                mock(RULE)
            ))
            .is_empty()
        );
    }

    #[test]
    fn mock_detection_needs_a_table_value() {
        let (directory, paths) = write("[lint]\n");
        let path = directory.path().join(CONFIG_FILE_NAME);
        assert!(!has_mock_table(&path, &paths).expect("parses"));
        std::fs::write(&path, "mock = \"x\"\n").expect("written");
        assert!(!has_mock_table(&path, &paths).expect("parses"));
        std::fs::write(&path, "[mock]\n").expect("written");
        assert!(has_mock_table(&path, &paths).expect("parses"));
        std::fs::write(&path, "[mock\n").expect("written");
        assert!(has_mock_table(&path, &paths).is_err());
    }

    #[test]
    fn a_table_without_rules_is_rejected() {
        assert_eq!(
            rejection("[mock]\nsrc = \"src\"\n"),
            [format!(
                "config {CONFIG_FILE_NAME}: [mock] has no [[mock.rules]] entry"
            )]
        );
    }

    #[test]
    fn unknown_keys_are_named_at_every_level() {
        for (snippet, key) in [
            (mock(&format!("bogus = 1\n{RULE}")), "bogus"),
            (mock(&format!("{AUTH}bogus = 1\n{RULE}")), "bogus"),
            (
                mock(&format!(
                    "caller_type = {{ name = \"C\", module = \"a/C\", bogus = 1 }}\n{RULE}"
                )),
                "bogus",
            ),
            (
                mock(&format!(
                    "[mock.inject.b]\nmodule = \"a/B\"\ntype = {{ name = \"B\", module = \"a/B\" }}\ncall = \"r()\"\nbogus = 1\n{RULE}"
                )),
                "bogus",
            ),
            (
                mock(&format!("{AUTH}{RULE}prf.prefix = \"P_\"\n")),
                "prefix",
            ),
            (
                mock(&format!("{RULE}init = {{ flag = \"f\", when = 1 }}\n")),
                "when",
            ),
        ] {
            let errors = rejection(&snippet);
            assert_eq!(errors.len(), 1, "{snippet}: {errors:?}");
            assert!(errors[0].contains(key), "{snippet}: {errors:?}");
        }
    }

    #[test]
    fn a_rule_key_that_is_no_rule_key_and_no_authenticator_is_unknown() {
        assert_eq!(
            rejection(&mock(&format!("{RULE}ecdsa.init = \"none\"\n"))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: unknown key ecdsa; not a rule key or an authenticator name"
            )]
        );
        assert!(
            rejection(&mock(&format!(
                "{AUTH}{RULE}prf.init = \"none\"\ncaller.exclude = []\n"
            )))
            .is_empty()
        );
    }

    #[test]
    fn value_shapes_parse_and_any_other_shape_is_an_error() {
        for snippet in [
            "salt = \"s\"",
            "salt = { ledger = \"_s\" }",
            "salt = { expr = \"pad(32, \\\"x\\\")\" }",
            "init = \"auto\"",
            "init = \"none\"",
            "init = \"plain\"",
            "init = { flag = \"ready\" }",
            "init = { circuit = \"setup\" }",
            "init = { flag = \"f\", circuit = \"setup\" }",
            "ledger = true",
            "ledger = [\"_a\"]",
            "ledger_names = \"plain\"",
            "ledger_names = \"prefixed\"",
            "include = false",
            "include = \"X.fragment.compact\"",
            "guard = [\"a\"]",
            "implements = [{ name = \"I\", module = \"a/I\" }]",
            "instances = [{ suffix = \"A\" }]",
            "merge = false",
        ] {
            assert!(
                rejection(&mock(&format!("{RULE}{snippet}\n"))).is_empty(),
                "{snippet}"
            );
        }
        for snippet in [
            "salt = 1",
            "salt = { ledger = \"a\", expr = \"b\" }",
            "salt = {}",
            "init = \"sometimes\"",
            "ledger = \"no\"",
            "ledger_names = \"bare\"",
            "include = 3",
            "guard = \"all\"",
            "implements = [{ name = \"I\" }]",
            "instances = 1",
            "merge = \"yes\"",
            "exclude = \"a\"",
            "auth = \"prf\"",
        ] {
            let errors = rejection(&mock(&format!("{RULE}{snippet}\n")));
            assert_eq!(errors.len(), 1, "{snippet}: {errors:?}");
        }
    }

    #[test]
    fn test_dir_starts_with_dir_and_stays_relative() {
        assert_eq!(test_tail("{dir}/test"), Some(vec!["test".to_owned()]));
        assert_eq!(
            test_tail("{dir}/test/unit"),
            Some(vec!["test".to_owned(), "unit".to_owned()])
        );
        for bad in [
            "test",
            "{dir}",
            "{dir}/",
            "{dir}/../x",
            "{dir}/{module}",
            "{dir}//x/../y",
            "x/{dir}/test",
        ] {
            assert_eq!(test_tail(bad), None, "{bad}");
        }
        assert_eq!(
            rejection(&mock(&format!("test_dir = \"tests\"\n{RULE}"))),
            [format!(
                "config {CONFIG_FILE_NAME}: test_dir \"tests\" must start with {{dir}}/ and use no other placeholder, no .. and no absolute path"
            )]
        );
    }

    #[test]
    fn src_must_exist_and_stay_relative() {
        assert_eq!(
            rejection(&mock(&format!("src = \"missing\"\n{RULE}"))),
            [format!(
                "config {CONFIG_FILE_NAME}: src directory missing does not exist"
            )]
        );
        let errors = rejection(&mock(&format!("src = \"/abs\"\n{RULE}")));
        assert!(
            errors[0].ends_with("src \"/abs\" must be a path relative to the config file"),
            "{errors:?}"
        );
    }

    #[test]
    fn spdx_is_one_non_empty_line() {
        assert!(rejection(&mock(&format!("spdx = \"MIT\"\n{RULE}"))).is_empty());
        for spdx in ["\"\"", "\"MIT\\nApache\""] {
            assert_eq!(
                rejection(&mock(&format!("spdx = {spdx}\n{RULE}"))),
                [format!(
                    "config {CONFIG_FILE_NAME}: spdx must be a single line"
                )]
            );
        }
    }

    #[test]
    fn authenticator_names_are_lowercase_and_never_a_rule_key() {
        let auth = |name: &str| {
            mock(&format!(
                "caller_type = {{ name = \"C\", module = \"a/C\" }}\n[mock.auth.{name}]\nmodule = \"a/A\"\ncall = \"f()\"\n{RULE}"
            ))
        };
        assert!(rejection(&auth("ecdsa_2")).is_empty());
        assert_eq!(
            rejection(&auth("init")),
            [format!(
                "config {CONFIG_FILE_NAME}: authenticator name init is a rule key; pick another name"
            )]
        );
        assert_eq!(rejection(&auth("Prf")).len(), 1);
    }

    #[test]
    fn the_caller_table_sets_only_its_suffix() {
        assert!(
            rejection(&mock(&format!(
                "[mock.auth.caller]\nsuffix = \"Raw\"\n{RULE}"
            )))
            .is_empty()
        );
        assert_eq!(
            rejection(&mock(&format!(
                "[mock.auth.caller]\nmodule = \"a/A\"\n{RULE}"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [mock.auth.caller] may set only suffix"
            )]
        );
    }

    #[test]
    fn an_authenticator_needs_module_call_and_the_caller_type() {
        assert_eq!(
            rejection(&mock(&format!(
                "caller_type = {{ name = \"C\", module = \"a/C\" }}\n[mock.auth.prf]\nmodule = \"a/A\"\n{RULE}"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [mock.auth.prf] needs module and call"
            )]
        );
        assert_eq!(
            rejection(&mock(&format!(
                "[mock.auth.prf]\nmodule = \"a/A\"\ncall = \"f()\"\n{RULE}"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [mock.auth.prf] needs [mock].caller_type"
            )]
        );
    }

    #[test]
    fn the_salt_slot_is_a_pad_or_a_bare_literal_and_appears_once() {
        assert_eq!(
            salt_slot("authenticate(pad(32, \"{salt}\"))"),
            Ok(Some(SaltSlot {
                start: 13,
                end: 30,
                width: Some(32)
            }))
        );
        assert_eq!(
            salt_slot("authenticate(pad( 16 ,  \"{salt}\" ))")
                .map(|slot| slot.and_then(|slot| slot.width)),
            Ok(Some(16))
        );
        assert_eq!(
            salt_slot("authenticate(\"{salt}\")"),
            Ok(Some(SaltSlot {
                start: 13,
                end: 21,
                width: None
            }))
        );
        assert_eq!(salt_slot("authenticateForThisContract()"), Ok(None));
        for bad in [
            "authenticate({salt})",
            "f(pad(32, \"{salt}\"), \"{salt}\")",
            "f(\"x{salt}\")",
            "f('{salt}')",
        ] {
            assert_eq!(salt_slot(bad), Err(()), "{bad}");
        }
        assert_eq!(
            rejection(&mock(&format!(
                "caller_type = {{ name = \"C\", module = \"a/C\" }}\n[mock.auth.prf]\nmodule = \"a/A\"\ncall = \"f({{salt}})\"\n{RULE}"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [mock.auth.prf].call: {{salt}} may appear once, as pad(<n>, \"{{salt}}\") or \"{{salt}}\""
            )]
        );
    }

    #[test]
    fn a_salt_slot_fills_inside_the_literal_or_replaces_the_whole_slot() {
        let call = "authenticate(pad(32, \"{salt}\"))";
        let slot = salt_slot(call).expect("valid").expect("a slot");
        assert_eq!(
            slot.fill_text(call, "MockX"),
            "authenticate(pad(32, \"MockX\"))"
        );
        assert_eq!(
            slot.fill_expr(call, "S__instanceSalt"),
            "authenticate(S__instanceSalt)"
        );
        let call = "authenticate(\"{salt}\")";
        let slot = salt_slot(call).expect("valid").expect("a slot");
        assert_eq!(slot.fill_expr(call, "e"), "authenticate(e)");
    }

    #[test]
    fn rule_references_must_be_defined() {
        assert_eq!(
            rejection(&mock(&format!(
                "{RULE}auth = [\"prf\"]\ninject = [\"blinding\"]\n"
            ))),
            [
                format!(
                    "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: auth names prf, which [mock.auth] does not define"
                ),
                format!(
                    "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: inject names blinding, which [mock.inject] does not define"
                ),
            ]
        );
    }

    #[test]
    fn merge_needs_instances_and_rejects_plain_ledger_names() {
        assert_eq!(
            rejection(&mock(&format!("{RULE}merge = true\n"))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: merge needs instances"
            )]
        );
        assert_eq!(
            rejection(&mock(&format!(
                "{RULE}ledger_names = \"plain\"\ninstances = [{{ suffix = \"A\", group = \"G\" }}]\n"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: ledger_names = \"plain\" does not combine with a merged group"
            )]
        );
    }

    #[test]
    fn an_instance_sets_only_instance_keys_and_suffixes_are_unique() {
        assert_eq!(
            rejection(&mock(&format!(
                "{RULE}instances = [{{ suffix = \"A\", disclose = [] }}]\n"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: instance \"A\" sets disclose, which an instance cannot set"
            )]
        );
        assert_eq!(
            rejection(&mock(&format!(
                "{RULE}instances = [{{ suffix = \"\" }}, {{ suffix = \"\" }}]\n"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: instance suffix \"\" appears twice"
            )]
        );
    }

    #[test]
    fn a_name_template_uses_only_the_four_placeholders() {
        assert!(
            rejection(&mock(&format!(
                "{RULE}name = \"Mock{{dir}}{{module}}{{instance}}{{suffix}}\"\n"
            )))
            .is_empty()
        );
        assert_eq!(
            rejection(&mock(&format!("{RULE}name = \"Mock{{parent}}\"\n"))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: name \"Mock{{parent}}\" has an unknown placeholder {{parent}}"
            )]
        );
    }

    #[test]
    fn two_injectors_for_one_type_in_one_list_are_rejected() {
        let inject = |name: &str| {
            format!(
                "[mock.inject.{name}]\nmodule = \"a/B\"\ntype = {{ name = \"B\", module = \"a/B\" }}\ncall = \"r()\"\n"
            )
        };
        assert_eq!(
            rejection(&mock(&format!(
                "{}{}{RULE}inject = [\"one\", \"two\"]\n",
                inject("one"),
                inject("two")
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: injectors one and two both stand in for B"
            )]
        );
    }

    #[test]
    fn salt_in_a_caller_table_or_for_a_call_without_a_slot_is_rejected() {
        assert_eq!(
            rejection(&mock(&format!("{RULE}caller.salt = \"x\"\n"))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: salt does not apply to the caller authenticator"
            )]
        );
        assert_eq!(
            rejection(&mock(&format!(
                "caller_type = {{ name = \"C\", module = \"a/C\" }}\n[mock.auth.ecdsa]\nmodule = \"a/A\"\ncall = \"authenticateForThisContract()\"\n{RULE}ecdsa.salt = \"x\"\n"
            ))),
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: ecdsa.salt is set, but [mock.auth.ecdsa].call takes no salt"
            )]
        );
        assert!(rejection(&mock(&format!(
            "caller_type = {{ name = \"C\", module = \"a/C\" }}\n[mock.auth.ecdsa]\nmodule = \"a/A\"\ncall = \"authenticateForThisContract()\"\n{RULE}salt = \"x\"\n"
        ))).is_empty());
    }

    #[test]
    fn identifiers_are_checked_where_the_design_names_them() {
        let errors = rejection(&mock(&format!(
            "{AUTH}{RULE}prefix = \"P-\"\nrename = {{ x = \"1y\" }}\ninit = {{ flag = \"is ready\" }}\nprf.init = {{ circuit = \"$c\" }}\ninstances = [{{ suffix = \"a-b\" }}]\n"
        )));
        assert_eq!(errors.len(), 5, "{errors:?}");
    }

    #[test]
    fn an_invalid_glob_names_its_rule() {
        let errors = rejection(&mock("[[mock.rules]]\nmodules = [\"a/[\"]\n"));
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].starts_with(&format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #1: invalid glob \"a/[\""
            )),
            "{errors:?}"
        );
    }

    #[test]
    fn rules_fold_in_file_order_and_replace_lists_whole() {
        let (directory, paths) = write(&mock(&format!(
            "{AUTH}[[mock.rules]]\nmodules = [\"**\"]\nexclude = [\"a\"]\nguard = true\nauth = [\"prf\", \"caller\"]\nprf.exclude = [\"p\"]\n\
             [[mock.rules]]\nmodules = [\"x/*\"]\nexclude = [\"b\"]\nprf.init = \"none\"\n\
             [[mock.rules]]\nmodules = [\"y/*\"]\nexclude = [\"c\"]\n"
        )));
        let config = load(&directory.path().join(CONFIG_FILE_NAME), &paths).expect("loads");
        let indices = config.applicable("x/M");
        assert_eq!(indices, [0, 1]);
        let folded = fold(&config, &indices);
        assert_eq!(folded.settings.exclude, Some(vec!["b".to_owned()]));
        assert_eq!(folded.settings.guard, Some(Guard::All(true)));
        assert_eq!(folded.auth, ["prf", "caller"]);
        let prf = settings_for(&config, &indices, &folded.settings, "prf");
        assert_eq!(prf.exclude, Some(vec!["p".to_owned()]));
        assert_eq!(prf.init, Some(Init::None));
        let caller = settings_for(&config, &indices, &folded.settings, "caller");
        assert_eq!(caller.exclude, Some(vec!["b".to_owned()]));
        assert_eq!(caller.init, None);
    }

    #[test]
    fn defaults_fill_every_unset_key() {
        let (directory, paths) = write(&mock(RULE));
        let config = load(&directory.path().join(CONFIG_FILE_NAME), &paths).expect("loads");
        assert_eq!(config.src, directory.path().join("src"));
        assert_eq!(config.test_tail, ["test"]);
        assert!(config.spdx.is_none() && config.caller_type.is_none());
        assert_eq!(config.auths["caller"].suffix, "Caller");
        let folded = fold(&config, &config.applicable("a/M"));
        assert_eq!(folded.auth, ["caller"]);
        assert_eq!(folded.name, "Mock{module}{instance}{suffix}");
        assert!(folded.prefix.is_none() && folded.instances.is_none() && !folded.merge);
        let settings = folded.settings;
        assert!(settings.init.is_none() && settings.ledger.is_none() && settings.include.is_none());
        assert_eq!(
            config.artifacts_dir("a/M"),
            directory.path().join("src/a/test/artifacts")
        );
        assert_eq!(
            config.artifacts_dir("Root"),
            directory.path().join("src/test/artifacts")
        );
    }

    #[test]
    fn settings_replace_without_merging() {
        let base = Settings {
            exclude: Some(vec!["a".to_owned()]),
            init: Some(Init::Plain),
            ledger: Some(Ledger::All(true)),
            ..Settings::default()
        };
        let top = Settings {
            exclude: Some(vec!["b".to_owned()]),
            include: Some(Include::Default(false)),
            salt: Some(Salt::Ledger("_s".to_owned())),
            ..Settings::default()
        };
        let effective = top.over(&base);
        assert_eq!(effective.exclude, Some(vec!["b".to_owned()]));
        assert_eq!(effective.init, Some(Init::Plain));
        assert_eq!(effective.include, Some(Include::Default(false)));
        assert_eq!(effective.salt, Some(Salt::Ledger("_s".to_owned())));
    }

    #[test]
    fn import_paths_are_rebased_lexically() {
        for (from, to, expected) in [
            (
                "/s/access/test/artifacts",
                "/s/access/Gate.compact",
                "../../Gate",
            ),
            (
                "/s/access/test/artifacts",
                "/s/id/Id.compact",
                "../../../id/Id",
            ),
            ("/s/test/artifacts", "/s/Root.compact", "../../Root"),
            ("/s/access", "/s/access/Gate.compact", "./Gate"),
        ] {
            assert_eq!(import_path(Path::new(from), Path::new(to)), expected);
        }
    }

    #[test]
    fn discovery_returns_the_nearest_compact_toml_walking_up() {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        let nested = directory.path().join("a/b/c");
        std::fs::create_dir_all(&nested).expect("dirs are created");
        assert_eq!(discover(&nested), None);
        std::fs::write(directory.path().join(CONFIG_FILE_NAME), "").expect("written");
        assert_eq!(
            discover(&nested),
            Some(directory.path().join(CONFIG_FILE_NAME))
        );
        std::fs::write(directory.path().join("a/b").join(CONFIG_FILE_NAME), "").expect("written");
        assert_eq!(
            discover(&nested),
            Some(directory.path().join("a/b").join(CONFIG_FILE_NAME))
        );
    }

    #[test]
    fn normalize_resolves_dots_without_touching_the_disk() {
        assert_eq!(normalize(Path::new("a/./b/../c")), Path::new("a/c"));
        assert_eq!(normalize(Path::new("a/../../b")), Path::new("../b"));
        assert_eq!(normalize(Path::new("/a/../../b")), Path::new("/b"));
    }

    #[test]
    fn paths_print_relative_under_the_working_directory_and_absolute_outside_it() {
        let paths = Paths {
            cwd: "/work/case".into(),
        };
        assert_eq!(
            paths.show(Path::new("/work/case/src/M.compact")),
            "src/M.compact"
        );
        assert_eq!(paths.show(Path::new("/work/case")), ".");
        assert_eq!(
            paths.show(Path::new("/work/other/M.compact")),
            "/work/other/M.compact"
        );
    }
}
