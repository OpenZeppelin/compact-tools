//! `compact-mock.toml`: discovery, the serde model, structural validation, and the
//! lexical path arithmetic every emitted path goes through.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Unexpected, Visitor};

use crate::error::{ConfigError, Error};
use crate::params::is_name;

pub const CONFIG_FILE_NAME: &str = "compact-mock.toml";

const DEFAULT_SRC: &str = "src";
const DEFAULT_OUT_DIR: &str = "{dir}/test/mocks";
const SALT_PLACEHOLDER: &str = "{salt}";

/// The config after structural validation. Paths are absolute and normalized.
#[derive(Clone, Debug)]
pub struct Config {
    pub path: PathBuf,
    /// The config path as messages print it.
    pub shown: String,
    pub src: PathBuf,
    pub spdx: Option<String>,
    pub auth: Option<Auth>,
    pub entries: Vec<Entry>,
}

/// The `[auth]` table.
#[derive(Clone, Debug)]
pub struct Auth {
    pub module: String,
    pub prefix: Option<String>,
    pub call: String,
    pub caller_type: CallerType,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallerType {
    pub name: String,
    pub module: String,
}

/// One `[[mock]]` entry.
#[derive(Clone, Debug)]
pub struct Entry {
    pub module: String,
    pub name: Option<String>,
    pub prefix: Option<String>,
    /// The effective template: the entry's, else the top level's, else the default.
    pub out_dir: String,
    pub module_args: Vec<String>,
    pub circuit_args: BTreeMap<String, Vec<String>>,
    pub variants: Option<Vec<VariantKind>>,
    /// The keys a variant table may replace, as the entry sets them.
    pub settings: Settings,
    /// `[mock.auth]`.
    pub auth: Option<Settings>,
    /// `[mock.caller]`.
    pub caller: Option<Settings>,
}

impl Entry {
    /// The file stem of `module`.
    #[must_use]
    pub fn stem(&self) -> &str {
        self.module.rsplit('/').next().unwrap_or(&self.module)
    }

    /// The keys set on this entry that only an authenticated mock uses, in report order.
    pub fn auth_only_keys(&self) -> impl Iterator<Item = &'static str> {
        [
            ("variants", self.variants.is_some()),
            ("salt", self.settings.salt.is_some()),
            ("[mock.auth]", self.auth.is_some()),
            ("[mock.caller]", self.caller.is_some()),
        ]
        .into_iter()
        .filter_map(|(key, set)| set.then_some(key))
    }
}

/// The two variants an entry with a caller-typed parameter can produce.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VariantKind {
    Auth,
    Caller,
}

/// The per-variant keys. A variant table's key replaces the entry's, never merges.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub name: Option<String>,
    pub init: Option<Init>,
    pub exclude: Option<Vec<String>>,
    pub disclose: Option<Vec<String>>,
    pub guard: Option<Guard>,
    pub rename: Option<BTreeMap<String, String>>,
    pub include: Option<Include>,
    pub salt: Option<String>,
    /// Whether the module's exported ledger fields are exported; on by default.
    pub ledger: Option<bool>,
}

impl Settings {
    /// `self`'s keys where set, `entry`'s otherwise.
    #[must_use]
    pub fn over(&self, entry: &Self) -> Self {
        Self {
            name: self.name.clone().or_else(|| entry.name.clone()),
            init: self.init.clone().or_else(|| entry.init.clone()),
            exclude: self.exclude.clone().or_else(|| entry.exclude.clone()),
            disclose: self.disclose.clone().or_else(|| entry.disclose.clone()),
            guard: self.guard.clone().or_else(|| entry.guard.clone()),
            rename: self.rename.clone().or_else(|| entry.rename.clone()),
            include: self.include.clone().or_else(|| entry.include.clone()),
            salt: self.salt.clone().or_else(|| entry.salt.clone()),
            ledger: self.ledger.or(entry.ledger),
        }
    }
}

/// The constructor shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Init {
    None,
    Plain,
    Flag(String),
}

impl fmt::Display for Init {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::None => formatter.write_str("\"none\""),
            Self::Plain => formatter.write_str("\"plain\""),
            Self::Flag(flag) => write!(formatter, "{{ flag = \"{flag}\" }}"),
        }
    }
}

impl<'de> Deserialize<'de> for Init {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InitVisitor;

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct FlagTable {
            flag: String,
        }

        impl<'de> Visitor<'de> for InitVisitor {
            type Value = Init;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("\"none\", \"plain\" or { flag = \"<ident>\" }")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Init, E> {
                match value {
                    "none" => Ok(Init::None),
                    "plain" => Ok(Init::Plain),
                    other => Err(E::invalid_value(Unexpected::Str(other), &self)),
                }
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Init, A::Error> {
                let table = FlagTable::deserialize(de::value::MapAccessDeserializer::new(map))?;
                Ok(Init::Flag(table.flag))
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
        struct GuardVisitor;

        impl<'de> Visitor<'de> for GuardVisitor {
            type Value = Guard;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a boolean or a list of circuit names")
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Guard, E> {
                Ok(Guard::All(value))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Guard, A::Error> {
                Vec::<String>::deserialize(de::value::SeqAccessDeserializer::new(seq))
                    .map(Guard::Some)
            }
        }

        deserializer.deserialize_any(GuardVisitor)
    }
}

/// `include`: the default fragment name, or a file relative to the output directory.
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
#[serde(deny_unknown_fields)]
struct RawConfig {
    src: Option<String>,
    out_dir: Option<String>,
    spdx: Option<String>,
    auth: Option<RawAuth>,
    #[serde(default)]
    mock: Vec<RawEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAuth {
    module: String,
    prefix: Option<String>,
    call: String,
    caller_type: CallerType,
}

// The variant-level keys are spelled out again: `deny_unknown_fields` does not combine
// with `flatten`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    module: String,
    name: Option<String>,
    prefix: Option<String>,
    out_dir: Option<String>,
    #[serde(default)]
    module_args: Vec<String>,
    #[serde(default)]
    circuit_args: BTreeMap<String, Vec<String>>,
    init: Option<Init>,
    exclude: Option<Vec<String>>,
    disclose: Option<Vec<String>>,
    guard: Option<Guard>,
    rename: Option<BTreeMap<String, String>>,
    include: Option<Include>,
    salt: Option<String>,
    ledger: Option<bool>,
    variants: Option<Vec<String>>,
    auth: Option<Settings>,
    caller: Option<Settings>,
}

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

/// Reads, parses and structurally validates a config.
/// # Errors
/// Returns every structural error, in file order. A read or parse error is the only one.
pub fn load(path: &Path, paths: &Paths) -> Result<Config, Vec<Error>> {
    let path = paths.absolute(path);
    let cfg = paths.show(&path);
    let text = std::fs::read_to_string(&path).map_err(|source| {
        vec![Error::from(ConfigError::Read {
            cfg: cfg.clone(),
            source,
        })]
    })?;
    let raw: RawConfig = toml::from_str(&text).map_err(|source| {
        vec![Error::from(ConfigError::Parse {
            cfg: cfg.clone(),
            source,
        })]
    })?;

    let base = path.parent().map_or_else(PathBuf::new, Path::to_owned);
    let mut errors = Vec::new();
    let mut report = |error: ConfigError| errors.push(Error::from(error));

    if let Some(spdx) = &raw.spdx
        && (spdx.is_empty() || spdx.contains(['\n', '\r']))
    {
        report(ConfigError::Spdx { cfg: cfg.clone() });
    }

    let src = normalize(&base.join(raw.src.as_deref().unwrap_or(DEFAULT_SRC)));
    if !src.is_dir() {
        report(ConfigError::Src {
            cfg: cfg.clone(),
            dir: paths.show(&src),
        });
    }

    if let Some(template) = &raw.out_dir {
        check_out_dir(template, &cfg, &mut report);
    }

    let auth = raw.auth.map(|auth| {
        check_module(&auth.module, &cfg, &mut report);
        if let Some(prefix) = &auth.prefix {
            check_name("[auth].prefix", prefix, &cfg, &mut report);
        }
        if !salt_placeholder_in_string(&auth.call) {
            report(ConfigError::SaltPlaceholder { cfg: cfg.clone() });
        }
        check_module(&auth.caller_type.module, &cfg, &mut report);
        check_name(
            "[auth].caller_type.name",
            &auth.caller_type.name,
            &cfg,
            &mut report,
        );
        Auth {
            module: auth.module,
            prefix: auth.prefix,
            call: auth.call,
            caller_type: auth.caller_type,
        }
    });

    if raw.mock.is_empty() {
        report(ConfigError::NoEntries { cfg: cfg.clone() });
    }

    let default_out_dir = raw.out_dir.unwrap_or_else(|| DEFAULT_OUT_DIR.to_owned());
    let entries = raw
        .mock
        .into_iter()
        .map(|raw_entry| {
            entry(
                raw_entry,
                &default_out_dir,
                auth.is_some(),
                &cfg,
                &mut report,
            )
        })
        .collect();

    if errors.is_empty() {
        Ok(Config {
            path,
            shown: cfg,
            src,
            spdx: raw.spdx,
            auth,
            entries,
        })
    } else {
        Err(errors)
    }
}

fn entry(
    raw: RawEntry,
    default_out_dir: &str,
    has_auth: bool,
    cfg: &str,
    report: &mut impl FnMut(ConfigError),
) -> Entry {
    let module = raw.module;
    check_module(&module, cfg, report);
    let key = |name: &str| format!("{module}: {name}");

    if let Some(name) = &raw.name {
        check_name(&key("name"), name, cfg, report);
    }
    if let Some(prefix) = &raw.prefix {
        check_name(&key("prefix"), prefix, cfg, report);
    }
    if let Some(template) = &raw.out_dir {
        check_out_dir(template, cfg, report);
    }

    let mut bad_variants = false;
    let variants = raw.variants.map(|values| {
        let kinds: Vec<Option<VariantKind>> = values
            .iter()
            .map(|value| match value.as_str() {
                "auth" => Some(VariantKind::Auth),
                "caller" => Some(VariantKind::Caller),
                _ => None,
            })
            .collect();
        let repeated = kinds
            .iter()
            .enumerate()
            .any(|(at, kind)| kinds[..at].contains(kind));
        bad_variants = kinds.is_empty() || repeated || kinds.contains(&None);
        kinds.into_iter().flatten().collect()
    });

    let entry = Entry {
        out_dir: raw.out_dir.unwrap_or_else(|| default_out_dir.to_owned()),
        module,
        name: raw.name.clone(),
        prefix: raw.prefix,
        module_args: raw.module_args,
        circuit_args: raw.circuit_args,
        variants,
        settings: Settings {
            name: raw.name,
            init: raw.init,
            exclude: raw.exclude,
            disclose: raw.disclose,
            guard: raw.guard,
            rename: raw.rename,
            include: raw.include,
            salt: raw.salt,
            ledger: raw.ledger,
        },
        auth: raw.auth,
        caller: raw.caller,
    };
    let module = &entry.module;

    if !has_auth {
        for key in entry.auth_only_keys() {
            report(ConfigError::NeedsAuth {
                cfg: cfg.to_owned(),
                module: module.clone(),
                key: key.to_owned(),
            });
        }
    }
    if bad_variants {
        report(ConfigError::Variants {
            cfg: cfg.to_owned(),
            module: module.clone(),
        });
    }
    if entry
        .caller
        .as_ref()
        .is_some_and(|caller| caller.salt.is_some())
    {
        report(ConfigError::CallerSalt {
            cfg: cfg.to_owned(),
            module: module.clone(),
        });
    }

    check_settings(&entry.settings, "", module, cfg, report);
    if let Some(auth) = &entry.auth {
        check_settings(auth, "auth.", module, cfg, report);
    }
    if let Some(caller) = &entry.caller {
        check_settings(caller, "caller.", module, cfg, report);
    }
    entry
}

/// The identifier rules a settings table can break. The entry's own `name` is checked
/// by the caller, so the entry level skips it.
fn check_settings(
    settings: &Settings,
    table: &str,
    module: &str,
    cfg: &str,
    report: &mut impl FnMut(ConfigError),
) {
    if !table.is_empty()
        && let Some(name) = &settings.name
    {
        check_name(&format!("{module}: {table}name"), name, cfg, report);
    }
    if let Some(Init::Flag(flag)) = &settings.init {
        check_name(&format!("{module}: {table}init.flag"), flag, cfg, report);
    }
    for (old, new) in settings.rename.iter().flatten() {
        check_name(&format!("{module}: {table}rename.{old}"), new, cfg, report);
    }
}

fn check_name(key: &str, value: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    if !is_name(value) {
        report(ConfigError::Identifier {
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

fn check_out_dir(template: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    if is_absolute(template) {
        report(ConfigError::OutDirAbsolute {
            cfg: cfg.to_owned(),
            value: template.to_owned(),
        });
    }
    check_placeholders(template, cfg, report);
}

fn check_placeholders(template: &str, cfg: &str, report: &mut impl FnMut(ConfigError)) {
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let (spelled, known, next) = match after.find('}') {
            Some(close) => (
                &rest[open..open + close + 2],
                matches!(&after[..close], "dir" | "parent"),
                &after[close + 1..],
            ),
            None => (&rest[open..], false, ""),
        };
        if !known {
            report(ConfigError::Placeholder {
                cfg: cfg.to_owned(),
                value: template.to_owned(),
                placeholder: spelled.to_owned(),
            });
            return;
        }
        rest = next;
    }
}

/// Whether `{salt}` occurs exactly once, inside a `"..."` literal.
fn salt_placeholder_in_string(call: &str) -> bool {
    if call.matches(SALT_PLACEHOLDER).count() != 1 {
        return false;
    }
    let mut in_string = false;
    let mut escaped = false;
    for (at, ch) in call.char_indices() {
        if call[at..].starts_with(SALT_PLACEHOLDER) {
            return in_string;
        }
        match ch {
            _ if escaped => escaped = false,
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            _ => {}
        }
    }
    false
}

/// Why an `out_dir` template does not expand for a module.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParentAtRoot;

/// Expands `{dir}` and `{parent}` for `module` (relative to `src`) into a directory
/// relative to `src`.
/// # Errors
/// Returns [`ParentAtRoot`] when the template uses `{parent}` for a module at the root.
pub fn expand_out_dir(template: &str, module: &str) -> Result<PathBuf, ParentAtRoot> {
    let dir = module.rsplit_once('/').map_or(".", |(dir, _)| dir);
    let parent = if dir == "." {
        None
    } else {
        Some(dir.rsplit_once('/').map_or(".", |(parent, _)| parent))
    };
    if template.contains("{parent}") && parent.is_none() {
        return Err(ParentAtRoot);
    }
    let expanded = template
        .replace("{dir}", dir)
        .replace("{parent}", parent.unwrap_or("."));
    Ok(normalize(Path::new(&expanded)))
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        CONFIG_FILE_NAME, Guard, Include, Init, ParentAtRoot, Paths, Settings, discover,
        expand_out_dir, import_path, load, normalize, salt_placeholder_in_string,
    };

    const AUTH: &str = "[auth]\nmodule = \"a/A\"\ncall = 'f(\"{salt}\")'\ncaller_type = { name = \"C\", module = \"a/C\" }\n";

    fn rejection(snippet: &str) -> Vec<String> {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        std::fs::create_dir(directory.path().join("src")).expect("src is created");
        let path = directory.path().join(CONFIG_FILE_NAME);
        std::fs::write(&path, snippet).expect("the config is written");
        let paths = Paths {
            cwd: directory.path().to_owned(),
        };
        match load(&path, &paths) {
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

    #[test]
    fn a_minimal_entry_is_accepted() {
        assert!(rejection("[[mock]]\nmodule = \"access/Gate\"\n").is_empty());
    }

    #[test]
    fn an_unknown_key_is_named_in_every_table() {
        for snippet in [
            "bogus = 1\n[[mock]]\nmodule = \"a/M\"\n",
            "[auth]\nmodule = \"a/A\"\ncall = 'f(\"{salt}\")'\nbogus = 1\ncaller_type = { name = \"C\", module = \"a/C\" }\n[[mock]]\nmodule = \"a/M\"\n",
            "[auth]\nmodule = \"a/A\"\ncall = 'f(\"{salt}\")'\ncaller_type = { name = \"C\", module = \"a/C\", bogus = 1 }\n[[mock]]\nmodule = \"a/M\"\n",
            "[[mock]]\nmodule = \"a/M\"\nbogus = 1\n",
            "[[mock]]\nmodule = \"a/M\"\nauth.bogus = 1\n",
            "[[mock]]\nmodule = \"a/M\"\ncaller.module_args = []\n",
        ] {
            let errors = rejection(snippet);
            assert_eq!(errors.len(), 1, "{snippet}");
            assert!(errors[0].contains("cannot parse config"), "{errors:?}");
            assert!(
                errors[0].contains("bogus") || errors[0].contains("module_args"),
                "{errors:?}"
            );
        }
    }

    #[test]
    fn value_shapes_are_typed() {
        let errors = rejection("[[mock]]\nmodule = \"a/M\"\ninit = \"sometimes\"\n");
        assert!(errors[0].contains("cannot parse config"), "{errors:?}");
        let errors = rejection("[[mock]]\nmodule = \"a/M\"\nguard = \"all\"\n");
        assert!(errors[0].contains("cannot parse config"), "{errors:?}");
    }

    #[test]
    fn structural_errors_are_all_reported_in_file_order() {
        let errors = rejection(
            "spdx = \"MIT\\nApache\"\nout_dir = \"{dir}/{oops}\"\n\
             [[mock]]\nmodule = \"./a/M\"\nname = \"bad name\"\nvariants = []\n",
        );
        assert_eq!(
            errors,
            vec![
                format!("config {CONFIG_FILE_NAME}: spdx must be a single line"),
                format!(
                    "config {CONFIG_FILE_NAME}: out_dir \"{{dir}}/{{oops}}\" has an unknown placeholder {{oops}}"
                ),
                format!(
                    "config {CONFIG_FILE_NAME}: module \"./a/M\" is a path relative to src, without .compact"
                ),
                format!("config {CONFIG_FILE_NAME}: ./a/M: name \"bad name\" is not an identifier"),
                format!("config {CONFIG_FILE_NAME}: ./a/M: variants needs an [auth] table"),
                format!(
                    "config {CONFIG_FILE_NAME}: ./a/M: variants must be a non-empty subset of [\"auth\", \"caller\"]"
                ),
            ]
        );
    }

    #[test]
    fn a_config_without_entries_is_rejected() {
        assert_eq!(
            rejection("src = \"src\"\n"),
            vec![format!("config {CONFIG_FILE_NAME} has no [[mock]] entry")]
        );
    }

    #[test]
    fn a_repeated_variant_is_rejected() {
        let errors = rejection(
            "[auth]\nmodule = \"a/A\"\ncall = 'f(\"{salt}\")'\ncaller_type = { name = \"C\", module = \"a/C\" }\n\
             [[mock]]\nmodule = \"a/M\"\nvariants = [\"auth\", \"auth\"]\ncaller.salt = \"x\"\n",
        );
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(
            errors[0].ends_with("variants must be a non-empty subset of [\"auth\", \"caller\"]")
        );
        assert!(errors[1].ends_with("salt applies to the authenticated variant only"));
    }

    #[test]
    fn the_salt_placeholder_sits_once_inside_a_string() {
        assert!(salt_placeholder_in_string(
            "authenticate(pad(32, \"{salt}\"))"
        ));
        assert!(salt_placeholder_in_string("f(\"a\\\"{salt}\")"));
        assert!(!salt_placeholder_in_string("authenticate({salt})"));
        assert!(!salt_placeholder_in_string("f(\"{salt}\", \"{salt}\")"));
        assert!(!salt_placeholder_in_string("f()"));
    }

    #[test]
    fn a_variant_table_replaces_lists_without_merging() {
        let entry = Settings {
            exclude: Some(vec!["a".to_owned()]),
            init: Some(Init::Plain),
            guard: Some(Guard::All(true)),
            ..Settings::default()
        };
        let auth = Settings {
            exclude: Some(vec!["b".to_owned()]),
            include: Some(Include::Default(true)),
            ledger: Some(false),
            ..Settings::default()
        };
        let effective = auth.over(&entry);
        assert_eq!(effective.exclude, Some(vec!["b".to_owned()]));
        assert_eq!(effective.init, Some(Init::Plain));
        assert_eq!(effective.guard, Some(Guard::All(true)));
        assert_eq!(effective.include, Some(Include::Default(true)));
        assert_eq!(effective.ledger, Some(false));
    }

    #[test]
    fn out_dir_templates_expand_relative_to_src() {
        assert_eq!(
            expand_out_dir("{dir}/test/mocks", "access/Gate"),
            Ok("access/test/mocks".into())
        );
        assert_eq!(
            expand_out_dir("{dir}/test/mocks", "Root"),
            Ok("test/mocks".into())
        );
        assert_eq!(
            expand_out_dir("{parent}/mocks", "a/b/M"),
            Ok("a/mocks".into())
        );
        assert_eq!(expand_out_dir("{parent}/mocks", "Root"), Err(ParentAtRoot));
    }

    #[test]
    fn import_paths_are_rebased_lexically() {
        let cases = [
            (
                "/s/access/test/mocks",
                "/s/access/Gate.compact",
                "../../Gate",
            ),
            ("/s/access/test/mocks", "/s/id/Id.compact", "../../../id/Id"),
            ("/s/test/mocks", "/s/Root.compact", "../../Root"),
            ("/s/a/mocks", "/s/a/b/M.compact", "../b/M"),
            ("/s/access", "/s/access/Gate.compact", "./Gate"),
            ("/s/test/mocks", "/s/utils/X.compact", "../../utils/X"),
            (
                "/s/a/test/mocks",
                "/vendor/Y.compact",
                "../../../../vendor/Y",
            ),
        ];
        for (from, to, expected) in cases {
            assert_eq!(import_path(Path::new(from), Path::new(to)), expected);
        }
    }

    #[test]
    fn discovery_returns_the_nearest_config_walking_up() {
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
    fn a_missing_config_file_cannot_be_read() {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        let paths = Paths {
            cwd: directory.path().to_owned(),
        };
        let errors = load(&directory.path().join("missing.toml"), &paths).expect_err("missing");
        assert_eq!(errors[0].to_string(), "cannot read config missing.toml");
    }

    #[test]
    fn each_value_shape_parses_and_any_other_shape_is_a_parse_error() {
        for snippet in [
            "init = \"none\"",
            "init = \"plain\"",
            "init = { flag = \"ready\" }",
            "guard = true",
            "guard = false",
            "guard = [\"a\"]",
            "include = true",
            "include = \"M.fragment.compact\"",
            "circuit_args = { f = [\"Field\", \"3\"] }",
            "rename = { a = \"b\" }",
            "module_args = [\"1\"]",
            "ledger = false",
        ] {
            assert!(
                rejection(&format!("[[mock]]\nmodule = \"a/M\"\n{snippet}\n")).is_empty(),
                "{snippet}"
            );
        }
        for snippet in [
            "init = 1",
            "init = { flag = \"ready\", when = 1 }",
            "init = {}",
            "guard = \"all\"",
            "guard = [1]",
            "include = 3",
            "variants = \"auth\"",
            "circuit_args = { f = \"Field\" }",
            "rename = { a = 1 }",
            "module_args = \"1\"",
            "ledger = \"no\"",
            "exclude = \"a\"",
        ] {
            let errors = rejection(&format!("[[mock]]\nmodule = \"a/M\"\n{snippet}\n"));
            assert_eq!(errors.len(), 1, "{snippet}");
            assert!(errors[0].starts_with("cannot parse config "), "{errors:?}");
        }
        let errors = rejection(
            "[auth]\nmodule = \"a/A\"\ncall = 'f(\"{salt}\")'\ncaller_type = { name = \"C\" }\n[[mock]]\nmodule = \"a/M\"\n",
        );
        assert!(errors[0].contains("missing field `module`"), "{errors:?}");
    }

    #[test]
    fn a_variant_table_rejects_the_entry_only_keys() {
        for table in ["auth", "caller"] {
            for key in [
                "module = \"a/N\"",
                "prefix = \"P_\"",
                "module_args = []",
                "circuit_args = {}",
                "out_dir = \"{dir}\"",
                "variants = [\"auth\"]",
            ] {
                let errors = rejection(&format!(
                    "{AUTH}[[mock]]\nmodule = \"a/M\"\n{table}.{key}\n"
                ));
                assert_eq!(errors.len(), 1, "{table}.{key}");
                assert!(errors[0].starts_with("cannot parse config "), "{errors:?}");
            }
        }
    }

    #[test]
    fn defaults_fill_src_and_the_output_template_and_leave_names_to_derive() {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        std::fs::create_dir(directory.path().join("src")).expect("src is created");
        let path = directory.path().join(CONFIG_FILE_NAME);
        std::fs::write(
            &path,
            "[[mock]]\nmodule = \"a/M\"\n\n[[mock]]\nmodule = \"a/N\"\nout_dir = \"{dir}\"\n",
        )
        .expect("written");
        let paths = Paths {
            cwd: directory.path().to_owned(),
        };
        let config = load(&path, &paths).expect("the config loads");
        assert_eq!(config.src, directory.path().join("src"));
        assert_eq!(config.shown, CONFIG_FILE_NAME);
        assert!(config.spdx.is_none() && config.auth.is_none());
        let entry = &config.entries[0];
        assert_eq!(entry.out_dir, "{dir}/test/mocks");
        assert!(entry.name.is_none() && entry.prefix.is_none() && entry.variants.is_none());
        assert!(entry.settings.init.is_none() && entry.settings.ledger.is_none());
        assert_eq!(config.entries[1].out_dir, "{dir}");

        std::fs::write(
            &path,
            "out_dir = \"{dir}/gen\"\n[[mock]]\nmodule = \"a/M\"\n\n[[mock]]\nmodule = \"a/N\"\nout_dir = \"{dir}\"\n",
        )
        .expect("written");
        let config = load(&path, &paths).expect("the config loads");
        assert_eq!(config.entries[0].out_dir, "{dir}/gen");
        assert_eq!(config.entries[1].out_dir, "{dir}");
    }

    #[test]
    fn a_module_is_a_relative_path_without_the_compact_extension() {
        for module in ["a/M", "M", "a/b/c/M"] {
            assert!(
                rejection(&format!("[[mock]]\nmodule = \"{module}\"\n")).is_empty(),
                "{module}"
            );
        }
        for module in [
            "/a/M",
            "a/M.compact",
            "./a/M",
            "a/../M",
            "a//M",
            "a/",
            "",
            "a\\\\M",
            "..",
        ] {
            assert_eq!(
                rejection(&format!("[[mock]]\nmodule = \"{module}\"\n")),
                [format!(
                    "config {CONFIG_FILE_NAME}: module \"{}\" is a path relative to src, without .compact",
                    module.replace("\\\\", "\\")
                )],
                "{module}"
            );
        }
    }

    #[test]
    fn an_identifier_error_names_the_key_it_comes_from() {
        let errors = rejection(&format!(
            "{}[[mock]]\nmodule = \"a/M\"\nname = \"a-b\"\nprefix = \"P-\"\nrename = {{ x = \"1y\" }}\n\
             init = {{ flag = \"is ready\" }}\nauth.name = \"Mock M\"\nauth.init = {{ flag = \"$f\" }}\n\
             caller.rename = {{ z = \"\" }}\n",
            AUTH.replace("[auth]\n", "[auth]\nprefix = \"A-\"\n")
                .replace("name = \"C\"", "name = \"C.D\"")
        ));
        let keys: Vec<&str> = errors
            .iter()
            .map(|error| {
                error
                    .strip_prefix(&format!("config {CONFIG_FILE_NAME}: "))
                    .and_then(|rest| rest.split(" \"").next())
                    .unwrap_or(error)
            })
            .collect();
        assert_eq!(
            keys,
            [
                "[auth].prefix",
                "[auth].caller_type.name",
                "a/M: name",
                "a/M: prefix",
                "a/M: init.flag",
                "a/M: rename.x",
                "a/M: auth.name",
                "a/M: auth.init.flag",
                "a/M: caller.rename.z",
            ]
        );
    }

    #[test]
    fn every_key_that_needs_an_auth_table_is_reported() {
        assert_eq!(
            rejection(
                "[[mock]]\nmodule = \"a/M\"\nvariants = [\"auth\"]\nsalt = \"s\"\nauth.init = \"none\"\ncaller.exclude = []\n"
            ),
            ["variants", "salt", "[mock.auth]", "[mock.caller]"]
                .map(|key| format!("config {CONFIG_FILE_NAME}: a/M: {key} needs an [auth] table"))
        );
    }

    #[test]
    fn variants_are_a_non_empty_subset_of_auth_and_caller() {
        for variants in ["[\"auth\"]", "[\"caller\"]", "[\"caller\", \"auth\"]"] {
            assert!(
                rejection(&format!(
                    "{AUTH}[[mock]]\nmodule = \"a/M\"\nvariants = {variants}\n"
                ))
                .is_empty(),
                "{variants}"
            );
        }
        for variants in ["[]", "[\"other\"]", "[\"auth\", \"auth\"]", "[\"Auth\"]"] {
            assert_eq!(
                rejection(&format!(
                    "{AUTH}[[mock]]\nmodule = \"a/M\"\nvariants = {variants}\n"
                )),
                [format!(
                    "config {CONFIG_FILE_NAME}: a/M: variants must be a non-empty subset of [\"auth\", \"caller\"]"
                )],
                "{variants}"
            );
        }
    }

    #[test]
    fn spdx_is_one_non_empty_line() {
        assert!(rejection("spdx = \"MIT OR Apache-2.0\"\n[[mock]]\nmodule = \"a/M\"\n").is_empty());
        for spdx in ["\"\"", "\"MIT\\nApache\"", "\"MIT\\r\""] {
            assert_eq!(
                rejection(&format!("spdx = {spdx}\n[[mock]]\nmodule = \"a/M\"\n")),
                [format!(
                    "config {CONFIG_FILE_NAME}: spdx must be a single line"
                )],
                "{spdx}"
            );
        }
    }

    #[test]
    fn out_dir_takes_only_the_dir_and_parent_placeholders() {
        for template in [
            "{dir}/test/mocks",
            "{parent}/mocks/{dir}",
            "mocks",
            "../{dir}",
        ] {
            assert!(
                rejection(&format!(
                    "out_dir = \"{template}\"\n[[mock]]\nmodule = \"a/b/M\"\n"
                ))
                .is_empty(),
                "{template}"
            );
        }
        for (template, placeholder) in [
            ("{name}", "{name}"),
            ("x/{dir", "{dir"),
            ("{}/x", "{}"),
            ("{dir}/{parent", "{parent"),
        ] {
            assert_eq!(
                rejection(&format!(
                    "[[mock]]\nmodule = \"a/M\"\nout_dir = \"{template}\"\n"
                )),
                [format!(
                    "config {CONFIG_FILE_NAME}: out_dir \"{template}\" has an unknown placeholder {placeholder}"
                )],
                "{template}"
            );
        }
    }

    #[test]
    fn an_absolute_out_dir_is_rejected_at_the_top_level_and_in_an_entry() {
        assert_eq!(
            rejection("out_dir = \"/m/{dir}\"\n[[mock]]\nmodule = \"a/M\"\nout_dir = \"/n\"\n"),
            ["/m/{dir}", "/n"].map(|value| format!(
                "config {CONFIG_FILE_NAME}: out_dir \"{value}\" must be a path relative to src"
            ))
        );
    }

    #[test]
    fn the_salt_placeholder_must_sit_in_a_double_quoted_string() {
        assert!(!salt_placeholder_in_string("f('{salt}')"));
        assert!(!salt_placeholder_in_string("f(\"a\", {salt})"));
        assert!(!salt_placeholder_in_string("f(\"\\\"\", {salt})"));
        assert!(salt_placeholder_in_string("f(pad(32, \"x-{salt}-y\"))"));
    }

    #[test]
    fn normalize_resolves_dots_without_touching_the_disk() {
        assert_eq!(normalize(Path::new("a/./b/../c")), Path::new("a/c"));
        assert_eq!(normalize(Path::new("a/../../b")), Path::new("../b"));
        assert_eq!(normalize(Path::new("/a/../../b")), Path::new("/b"));
        assert_eq!(normalize(Path::new("./")), Path::new(""));
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
        assert_eq!(
            paths.absolute(Path::new("../x/./y")),
            Path::new("/work/x/y")
        );
    }
}
