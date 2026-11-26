//! Every message the generator prints, one variant each.
//!
//! Paths inside a message are already in their printed form: relative to the working
//! directory when under it, otherwise absolute.

use std::io;

use thiserror::Error;

/// Any error a run reports. A run collects them, prints them all and writes nothing.
#[derive(Debug, Error)]
pub enum Error {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Plan(#[from] PlanError),
    #[error(transparent)]
    Output(#[from] OutputError),
}

/// Errors in `compact-mock.toml`, its discovery, and the mock names it selects.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("no compact-mock.toml in {cwd} or any parent; pass --config <FILE>")]
    NotFound { cwd: String },
    #[error("cannot read config {cfg}")]
    Read {
        cfg: String,
        #[source]
        source: io::Error,
    },
    #[error("cannot parse config {cfg}")]
    Parse {
        cfg: String,
        #[source]
        source: toml::de::Error,
    },
    #[error("config {cfg} has no [[mock]] entry")]
    NoEntries { cfg: String },
    #[error("config {cfg}: module \"{module}\" is a path relative to src, without .compact")]
    Module { cfg: String, module: String },
    #[error("config {cfg}: src directory {dir} does not exist")]
    Src { cfg: String, dir: String },
    #[error("config {cfg}: {key} \"{value}\" is not an identifier")]
    Identifier {
        cfg: String,
        key: String,
        value: String,
    },
    #[error("config {cfg}: {module}: {key} needs an [auth] table")]
    NeedsAuth {
        cfg: String,
        module: String,
        key: String,
    },
    #[error(
        "config {cfg}: {module}: variants must be a non-empty subset of [\"auth\", \"caller\"]"
    )]
    Variants { cfg: String, module: String },
    #[error("config {cfg}: {module}: salt applies to the authenticated variant only")]
    CallerSalt { cfg: String, module: String },
    #[error("config {cfg}: {mock}: include \"{value}\" must end in .fragment.compact")]
    IncludeSuffix {
        cfg: String,
        mock: String,
        value: String,
    },
    #[error(
        "config {cfg}: [auth].call must contain {{salt}} exactly once, inside a \"...\" string"
    )]
    SaltPlaceholder { cfg: String },
    #[error("config {cfg}: {mock}: out_dir uses {{parent}}, but {module} sits at the root of src")]
    ParentAtRoot {
        cfg: String,
        mock: String,
        module: String,
    },
    /// `placeholder` is spelled as written, braces included: `{name}`, or `{dir` unclosed.
    #[error("config {cfg}: out_dir \"{value}\" has an unknown placeholder {placeholder}")]
    Placeholder {
        cfg: String,
        value: String,
        placeholder: String,
    },
    #[error("config {cfg}: spdx must be a single line")]
    Spdx { cfg: String },
    #[error("config {cfg}: two mocks are named {mock}")]
    DuplicateName { cfg: String, mock: String },
    #[error("config {cfg}: {mock} and {other} both write {path}")]
    DuplicatePath {
        cfg: String,
        mock: String,
        other: String,
        path: String,
    },
    #[error("no mock named {name} in {cfg}")]
    UnknownName { name: String, cfg: String },
}

/// Errors reading or parsing a Compact source the plan needs.
#[derive(Debug, Error)]
pub enum SourceError {
    #[error("cannot read {path}")]
    Read {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("{path}:{line}:{column}: parse error")]
    Parse {
        path: String,
        line: usize,
        column: usize,
    },
    #[error("{path}: expected one module declaration, found {count}")]
    ModuleCount { path: String, count: usize },
    #[error("{path}: no pragma to copy into the mock")]
    NoPragma { path: String },
    #[error("{path}: import \"{import}\" does not resolve to {target}")]
    Import {
        path: String,
        import: String,
        target: String,
    },
}

/// Errors in the `[auth]` table that need the authenticator's source to detect.
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("[auth].call calls {circuit}, which {module} does not export")]
    Call { circuit: String, module: String },
    #[error("[auth].caller_type: {module} declares no struct {name}")]
    CallerType { module: String, name: String },
}

/// Errors planning one mock. `mock` is the generated name.
#[derive(Debug, Error)]
pub enum PlanError {
    #[error("{mock}: {module} has no {caller} parameter, so {key} does not apply")]
    NoCallerParam {
        mock: String,
        module: String,
        caller: String,
        key: String,
    },
    #[error("{mock}: {key} names {circuit}, which {module} does not export as a circuit")]
    UnknownCircuit {
        mock: String,
        key: String,
        circuit: String,
        module: String,
    },
    #[error("{mock}: {key} names {circuit}, which {mock} does not expose")]
    NotExposed {
        mock: String,
        key: String,
        circuit: String,
    },
    #[error("{mock}: rename target {target} clashes with {existing}")]
    RenameClash {
        mock: String,
        target: String,
        existing: String,
    },
    #[error("{mock}: disclose names {circuit}, which returns []")]
    DiscloseUnit { mock: String, circuit: String },
    #[error(
        "{mock}: circuit {circuit} has type parameters {generics}; set circuit_args.{circuit} or add it to exclude"
    )]
    GenericNoArgs {
        mock: String,
        circuit: String,
        generics: String,
    },
    #[error("{mock}: circuit_args.{circuit} has {given} arguments; {circuit} takes {takes}")]
    CircuitArgsCount {
        mock: String,
        circuit: String,
        given: usize,
        takes: usize,
    },
    #[error("{mock}: circuit_args.{circuit}: {circuit} has no type parameters")]
    CircuitArgsNotGeneric { mock: String, circuit: String },
    #[error("{mock}: module_args has {given} arguments; {module} takes {takes}")]
    ModuleArgsCount {
        mock: String,
        given: usize,
        module: String,
        takes: usize,
    },
    #[error("{mock}: init = {init} needs an exported initialize circuit in {module}")]
    NoInitialize {
        mock: String,
        init: String,
        module: String,
    },
    #[error("{mock}: init flag {flag} clashes with an initialize parameter")]
    FlagClash { mock: String, flag: String },
    #[error(
        "{mock}: parameter {index} of {circuit} is a pattern; a wrapper needs a named parameter"
    )]
    Pattern {
        mock: String,
        index: usize,
        circuit: String,
    },
    #[error(
        "{mock}: {circuit} uses {ty}, which {module} does not export; the wrapper cannot name it"
    )]
    HiddenType {
        mock: String,
        circuit: String,
        ty: String,
        module: String,
    },
    #[error(
        "{mock}: {circuit} is re-exported by {module}'s export list and needs a wrapper; add it to exclude"
    )]
    ExportListWrapper {
        mock: String,
        circuit: String,
        module: String,
    },
    #[error("{mock}: salt \"{salt}\" is {bytes} bytes; pad(32, ...) takes at most 32. Set salt")]
    SaltLength {
        mock: String,
        salt: String,
        bytes: usize,
    },
    #[error("{mock}: salt must be non-empty and must not contain \", \\ or a control character")]
    SaltChars { mock: String },
    #[error("{mock}: fragment {path} does not exist")]
    FragmentMissing { mock: String, path: String },
    #[error("{mock}: fragment {path} declares a constructor; set init = \"none\"")]
    FragmentConstructor { mock: String, path: String },
    #[error(
        "{mock}: parameter {param} of {circuit} has type {ty}, which does not resolve; with [auth] set, every parameter type must resolve"
    )]
    Unresolved {
        mock: String,
        param: String,
        circuit: String,
        ty: String,
    },
    #[error(
        "{mock}: parameter {param} of {circuit} has type {ty}, which contains {caller} but is not it; add {circuit} to exclude"
    )]
    ContainsCaller {
        mock: String,
        param: String,
        circuit: String,
        ty: String,
        caller: String,
    },
    #[error("{mock}: prefix {prefix} is used by two imports ({first} and {second})")]
    PrefixCollision {
        mock: String,
        prefix: String,
        first: String,
        second: String,
    },
}

/// Errors owning, reading or writing a generated file.
#[derive(Debug, Error)]
pub enum OutputError {
    #[error(
        "{path} exists without the compact-mock marker; move or delete it to let compact-mock own it"
    )]
    NotOwned { path: String },
    #[error("cannot read {path}")]
    Read {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("cannot write {path}")]
    Write {
        path: String,
        #[source]
        source: io::Error,
    },
}
