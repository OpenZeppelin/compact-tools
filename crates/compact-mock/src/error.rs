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
    #[error(transparent)]
    Build(#[from] BuildError),
}

/// Errors in the `[mock]` table, its discovery, and the mock names it selects.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("no compact.toml in {cwd} or any parent; pass --config <FILE>")]
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
    #[error("config {cfg} has no [mock] table")]
    NoMockTable { cfg: String },
    /// `message` is the TOML or serde text, which names the offending key.
    #[error("config {cfg}: {at}: {message}")]
    Invalid {
        cfg: String,
        at: String,
        message: String,
    },
    #[error("config {cfg}: [mock] has no [[mock.rules]] entry")]
    NoRules { cfg: String },
    #[error(
        "config {cfg}: test_dir \"{value}\" must start with {{dir}}/ and use no other placeholder, no .. and no absolute path"
    )]
    TestDir { cfg: String, value: String },
    #[error("config {cfg}: module \"{module}\" is a path relative to src, without .compact")]
    Module { cfg: String, module: String },
    #[error("config {cfg}: src directory {dir} does not exist")]
    Src { cfg: String, dir: String },
    #[error("config {cfg}: src \"{value}\" must be a path relative to the config file")]
    SrcAbsolute { cfg: String, value: String },
    #[error("config {cfg}: {key} \"{value}\" is not an identifier")]
    Identifier {
        cfg: String,
        key: String,
        value: String,
    },
    #[error("config {cfg}: {key} \"{value}\" may hold only letters, digits and _")]
    Suffix {
        cfg: String,
        key: String,
        value: String,
    },
    #[error("config {cfg}: spdx must be a single line")]
    Spdx { cfg: String },
    #[error("config {cfg}: {at}: invalid glob \"{pattern}\"")]
    Glob {
        cfg: String,
        at: String,
        pattern: String,
        #[source]
        source: globset::Error,
    },
    #[error("config {cfg}: [[mock.rules]] #{number} has no modules")]
    RuleModules { cfg: String, number: usize },
    #[error("config {cfg}: [[mock.rules]] #{number} applies to no module under {src}")]
    RuleUnused {
        cfg: String,
        number: usize,
        src: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: unknown key {key}; not a rule key or an authenticator name"
    )]
    UnknownRuleKey {
        cfg: String,
        number: usize,
        key: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: {key} names {circuit}, which no module the rule applies to exports"
    )]
    RuleCircuit {
        cfg: String,
        number: usize,
        key: String,
        circuit: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: ledger names {field}, which no module the rule applies to exports as a ledger field"
    )]
    RuleLedger {
        cfg: String,
        number: usize,
        field: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: init = {init}, but no module the rule applies to exports {circuit}"
    )]
    RuleInit {
        cfg: String,
        number: usize,
        init: String,
        circuit: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: auth names {name}, which [mock.auth] does not define"
    )]
    AuthUndefined {
        cfg: String,
        number: usize,
        name: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: inject names {name}, which [mock.inject] does not define"
    )]
    InjectUndefined {
        cfg: String,
        number: usize,
        name: String,
    },
    #[error("config {cfg}: [[mock.rules]] #{number}: merge needs instances")]
    MergeNeedsInstances { cfg: String, number: usize },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: ledger_names = \"plain\" does not combine with a merged group"
    )]
    PlainWithMerge { cfg: String, number: usize },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: instance \"{suffix}\" sets {key}, which an instance cannot set"
    )]
    InstanceKey {
        cfg: String,
        number: usize,
        suffix: String,
        key: String,
    },
    #[error("config {cfg}: [[mock.rules]] #{number}: instance suffix \"{suffix}\" appears twice")]
    SuffixTwice {
        cfg: String,
        number: usize,
        suffix: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: name \"{value}\" has an unknown placeholder {{{placeholder}}}"
    )]
    NamePlaceholder {
        cfg: String,
        number: usize,
        value: String,
        placeholder: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: injectors {first} and {second} both stand in for {ty}"
    )]
    InjectorsOneType {
        cfg: String,
        number: usize,
        first: String,
        second: String,
        ty: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: salt does not apply to the caller authenticator"
    )]
    CallerSalt { cfg: String, number: usize },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: {name}.salt is set, but [mock.auth.{name}].call takes no salt"
    )]
    NoSaltSlot {
        cfg: String,
        number: usize,
        name: String,
    },
    #[error(
        "config {cfg}: [[mock.rules]] #{number}: include \"{value}\" must name a .fragment.compact file under the test directory"
    )]
    IncludeFile {
        cfg: String,
        number: usize,
        value: String,
    },
    #[error("config {cfg}: {at}: salt expr must be one non-empty line")]
    SaltExpr { cfg: String, at: String },
    #[error("config {cfg}: authenticator name {name} is a rule key; pick another name")]
    AuthNameIsRuleKey { cfg: String, name: String },
    #[error("config {cfg}: authenticator or injector name {name} must match [a-z][a-z0-9_]*")]
    AuthName { cfg: String, name: String },
    #[error("config {cfg}: [mock.auth.caller] may set only suffix")]
    CallerTable { cfg: String },
    #[error("config {cfg}: [mock.auth.{name}] needs module and call")]
    AuthFields { cfg: String, name: String },
    #[error(
        "config {cfg}: [mock.auth.{name}].call: {{salt}} may appear once, as pad(<n>, \"{{salt}}\") or \"{{salt}}\""
    )]
    SaltSlot { cfg: String, name: String },
    #[error("config {cfg}: [mock.auth.{name}] needs [mock].caller_type")]
    AuthNeedsCallerType { cfg: String, name: String },
    #[error("config {cfg}: [mock.inject.{name}].call takes no placeholder")]
    InjectPlaceholder { cfg: String, name: String },
    #[error(
        "config {cfg}: two mocks are named {mock} (ignoring case), from {first} and {second}; add {{dir}} or {{instance}} to the name template"
    )]
    DuplicateName {
        cfg: String,
        mock: String,
        first: String,
        second: String,
    },
    #[error(
        "config {cfg}: name template \"{template}\" gives \"{value}\" for {module}, which is not an identifier"
    )]
    NameIdentifier {
        cfg: String,
        template: String,
        value: String,
        module: String,
    },
    #[error("no mock named {name} in {cfg}")]
    UnknownName { name: String, cfg: String },
    #[error("--dir {dir} does not exist")]
    DirMissing { dir: String },
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

/// Errors in `[mock.auth.*]`, `[mock.inject.*]` and `caller_type` that need the
/// sources to detect.
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("[mock.auth.{name}].call calls {circuit}, which {module} does not export")]
    Call {
        name: String,
        circuit: String,
        module: String,
    },
    #[error("[mock.auth.{name}].call: {circuit} returns {ty}, not {caller}")]
    Returns {
        name: String,
        circuit: String,
        ty: String,
        caller: String,
    },
    #[error("[mock].caller_type: {module} declares no struct or new type {name}")]
    CallerType { module: String, name: String },
    #[error("[mock.inject.{name}].call calls {circuit}, which {module} does not export")]
    InjectCall {
        name: String,
        circuit: String,
        module: String,
    },
    #[error("[mock.inject.{name}].call: {circuit} returns {ty}, not {target}")]
    InjectReturns {
        name: String,
        circuit: String,
        ty: String,
        target: String,
    },
    #[error("[mock.inject.{name}].type: {module} declares no struct, enum or new type {ty}")]
    InjectType {
        name: String,
        module: String,
        ty: String,
    },
}

/// Errors planning one mock. `mock` is the generated name.
#[derive(Debug, Error)]
pub enum PlanError {
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
    #[error(
        "{mock}: circuit {circuit} has type parameters {generics} and the constructor calls it; set circuit_args.{circuit}"
    )]
    GenericInitialize {
        mock: String,
        circuit: String,
        generics: String,
    },
    /// `constructor` is set for the `initialize` the constructor calls.
    #[error(
        "{mock}: {module} exports {count} circuits named {circuit}, and overloads are not supported; {} or write the mock by hand",
        exclude_hint(.circuit, *.constructor)
    )]
    Overloaded {
        mock: String,
        module: String,
        count: usize,
        circuit: String,
        constructor: bool,
    },
    #[error(
        "{mock}: guarded circuit {circuit} has a parameter named _invocations, which hides the guard counter; leave {circuit} unguarded"
    )]
    GuardShadowed { mock: String, circuit: String },
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
    #[error("{mock}: init flag {flag} clashes with a constructor parameter")]
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
        "{mock}: salt \"{salt}\" is {bytes} bytes; pad({width}, ...) takes at most {width}. Set salt"
    )]
    SaltLength {
        mock: String,
        salt: String,
        bytes: usize,
        width: usize,
    },
    #[error("{mock}: salt ledger field {field} is not an exported ledger field of {module}")]
    SaltLedger {
        mock: String,
        field: String,
        module: String,
    },
    #[error("{mock}: {module} takes {count} generic arguments; set module_args or instances")]
    GenericModule {
        mock: String,
        module: String,
        count: usize,
    },
    #[error("{mock}: rename key \"{key}\" matches no overload of {circuit}")]
    RenameOverload {
        mock: String,
        key: String,
        circuit: String,
    },
    /// `instances` reads `<a> and <b>`; `args` names the module too.
    #[error("{mock}: instances {instances} pass the same module arguments {args}")]
    SameArgs {
        mock: String,
        instances: String,
        args: String,
    },
    /// `first` and `second` read `<type> in instance <suffix>`.
    #[error("{mock}: constructor parameter {param} has type {first} and {second}")]
    CtorParamClash {
        mock: String,
        param: String,
        first: String,
        second: String,
    },
    #[error(
        "{mock}: witness {witness} is declared by both {first} and {second}; compactc binds both to one witness function. Remove one import or write the mock by hand"
    )]
    WitnessClash {
        mock: String,
        witness: String,
        first: String,
        second: String,
    },
    #[error(
        "{mock}: implements {interface}, but {module} declares no exported contract {interface}"
    )]
    ImplementsNoContract {
        mock: String,
        interface: String,
        module: String,
    },
    #[error(
        "{mock}: implements {interface}, but exposes no circuit {circuit}; add it to {fragment}"
    )]
    ImplementsMissing {
        mock: String,
        interface: String,
        circuit: String,
        fragment: String,
    },
    #[error("{mock}: salt must be non-empty and must not contain \", \\ or a control character")]
    SaltChars { mock: String },
    #[error("{mock}: fragment {path} does not exist")]
    FragmentMissing { mock: String, path: String },
    #[error("{mock}: fragment {path} declares a constructor; set init = \"none\"")]
    FragmentConstructor { mock: String, path: String },
    #[error(
        "{mock}: parameter {param} of {circuit} has type {ty}, which does not resolve; with caller_type set, every parameter type must resolve"
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
    /// `contains` reads `<type>, which contains <caller type>`.
    #[error(
        "{mock}: parameter {param} of {circuit} has type {contains} but is not it; {}",
        exclude_hint(.circuit, true)
    )]
    ContainsCallerInitialize {
        mock: String,
        circuit: String,
        param: String,
        contains: String,
    },
    /// `constructor` is set for the `initialize` the constructor calls.
    #[error(
        "{mock}: {circuit} takes {count} {caller} parameters, and the authenticated mock would pass one caller to all of them; {}, or use the caller mock",
        exclude_hint(.circuit, *.constructor)
    )]
    CallerTwice {
        mock: String,
        circuit: String,
        count: usize,
        caller: String,
        constructor: bool,
    },
    /// `constructor` is set for the `initialize` the constructor calls.
    #[error(
        "{mock}: circuit_args.{circuit} sets a type parameter to {arg}, which is or contains {caller}, so the mock could take a caller it does not authenticate; {}",
        exclude_hint(.circuit, *.constructor)
    )]
    CallerArgument {
        mock: String,
        circuit: String,
        arg: String,
        caller: String,
        constructor: bool,
    },
    #[error(
        "{mock}: module_args sets a type parameter to {arg}, which is or contains {caller}, so the mock could take a caller it does not authenticate; write the mock by hand"
    )]
    CallerModuleArgument {
        mock: String,
        arg: String,
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

/// How to leave `circuit` out of a mock. The `initialize` the constructor calls leaves
/// only once it is a circuit again.
fn exclude_hint(circuit: &str, constructor: bool) -> String {
    if constructor {
        format!("set init = \"none\" and add {circuit} to exclude")
    } else {
        format!("add {circuit} to exclude")
    }
}

/// Errors owning, reading, writing or removing generated files.
#[derive(Debug, Error)]
pub enum OutputError {
    #[error(
        "{dir} exists and has no .compact-mock-stamp; compact-mock writes only into directories it owns. Move it away or empty it"
    )]
    NotOwned { dir: String },
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
    #[error("cannot remove {path}")]
    Remove {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("cannot write to stdout")]
    Stdout {
        #[source]
        source: io::Error,
    },
}

/// Errors running the `compact` toolchain.
#[derive(Debug, Error)]
pub enum BuildError {
    #[error("cannot run {bin}; install the Compact toolchain or pass --compact-bin")]
    CannotRun {
        bin: String,
        #[source]
        source: io::Error,
    },
    #[error("compact compile failed for {path} (exit {code})")]
    Failed { path: String, code: String },
}
