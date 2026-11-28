//! What each mock contains: expansion into mocks and instances, exposed circuits, the
//! action per circuit, imports, the export list, the constructor and the include.
//!
//! [`analyze`] validates the authenticators and injectors, walks the candidates, expands
//! every selected module, and plans the mocks in scope. Module errors stay with their
//! module, so a run can tolerate the ones outside its scope and the linter can report
//! them per file.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use crate::config::{
    self, AuthSpec, CALLER, Config, FRAGMENT_SUFFIX, Folded, Guard, Include, Init, InjectSpec,
    Ledger, LedgerNames, Salt, SaltSlot, Scope as InjectScope, Settings, import_path, module_dir,
    module_stem, normalize,
};
use crate::error::{AuthError, ConfigError, Error, PlanError, SourceError};
use crate::params::{collapse, identifiers, is_name, rewrite};
use crate::scope::{CallerMatch, Decl, DeclKind, FileId, Files, Lookup, MAX_DEPTH, Resolved};
use crate::select::{self, Candidate, Selection, SkipReason};
use crate::source::{Circuit, GenericParam, Item, Position, SourceFile};

/// Standard-library types a top-level `export { }` accepts.
const EXPORTABLE_STD: [&str; 12] = [
    "ContractAddress",
    "Either",
    "Maybe",
    "MerkleTreeDigest",
    "MerkleTreePath",
    "MerkleTreePathEntry",
    "QualifiedShieldedCoinInfo",
    "Secp256k1EcdsaSignature",
    "ShieldedCoinInfo",
    "ShieldedSendResult",
    "UserAddress",
    "ZswapCoinPublicKey",
];

const GUARD_LEDGER: &str = "_invocations";

/// One planned mock, ready to render.
#[derive(Clone, Debug)]
pub struct MockPlan {
    pub name: String,
    /// Absolute path of the generated source.
    pub path: PathBuf,
    /// The artifacts directory the source and its compiled output live in.
    pub artifacts: PathBuf,
    /// The module path, for the header.
    pub module: String,
    pub spdx: Option<String>,
    pub pragma: String,
    /// Group 2: one named import per interface.
    pub interfaces: Vec<ImportLine>,
    /// Group 3: named imports.
    pub named: Vec<ImportLine>,
    /// Group 4: prefixed and whole-module imports.
    pub prefixed: Vec<ImportLine>,
    /// `contract implements <I>;` lines, in config order.
    pub implements: Vec<String>,
    /// Types, then re-exported circuits, then prefixed pure circuits, then ledger fields.
    pub exports: Vec<String>,
    pub guard_ledger: bool,
    pub constructor: Option<Constructor>,
    pub wrappers: Vec<Wrapper>,
    /// The `include` path, without `.compact`.
    pub include: Option<String>,
    /// Indices into the module's exported circuits this mock exposes or calls.
    pub covered: BTreeSet<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportLine {
    Selective {
        names: Vec<String>,
        path: String,
        args: String,
    },
    Prefixed {
        path: String,
        args: String,
        prefix: String,
    },
    Whole {
        path: String,
        args: String,
    },
}

/// `<callee>(<args>)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub callee: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Param {
    pub name: String,
    pub ty: String,
}

/// The constructor: parameters, then one `Boolean` per flag, then one call per instance.
#[derive(Clone, Debug)]
pub struct Constructor {
    pub params: Vec<Param>,
    pub flags: Vec<String>,
    /// Each call with the flag that gates it.
    pub calls: Vec<(Option<String>, Call)>,
}

#[derive(Clone, Debug)]
pub struct Wrapper {
    pub name: String,
    pub pure: bool,
    pub params: Vec<Param>,
    pub ret: String,
    pub guard: bool,
    /// How many of the circuit's parameters an authenticator or injector call fills.
    pub injected: usize,
    pub disclose: bool,
    pub call: Call,
}

/// An exported circuit of a module, for coverage.
#[derive(Clone, Debug)]
pub struct SurfaceCircuit {
    pub name: String,
    pub at: Position,
}

/// What a run plans: every mock in scope, or only the named ones.
#[derive(Clone, Copy, Debug, Default)]
pub struct Scope<'a> {
    /// Only modules whose file lies under this directory are planned. Errors of the
    /// other modules never fail the run.
    pub dir: Option<&'a Path>,
    /// Only these mocks are planned; empty plans every mock in scope.
    pub names: &'a [String],
    /// compact-compiler file globs: only mocks whose module source or generated source one
    /// matches are planned, and other modules leave the scope. Empty keeps every mock.
    pub only: &'a [String],
}

impl Scope<'_> {
    fn covers(&self, file: &Path) -> bool {
        self.dir.is_none_or(|dir| file.starts_with(dir))
    }

    fn keeps(&self, sources: &[&Path], paths: &config::Paths) -> bool {
        self.only.is_empty()
            || sources.iter().any(|source| {
                self.only
                    .iter()
                    .any(|glob| select::file_glob(glob, source, paths))
            })
    }
}

/// One candidate module and what became of it.
#[derive(Debug)]
pub struct ModuleResult {
    pub module: String,
    pub file: PathBuf,
    pub in_scope: bool,
    pub status: Status,
}

#[derive(Debug)]
pub enum Status {
    Excluded,
    Unmatched,
    Skipped(SkipReason),
    /// Read and expanded. `errors` holds expansion and planning errors; `plans` the
    /// mocks planned without error.
    Mocks {
        names: Vec<String>,
        artifacts: PathBuf,
        plans: Vec<MockPlan>,
        circuits: Vec<SurfaceCircuit>,
        errors: Vec<Error>,
        /// Lines that do not fail the run, as printed.
        warnings: Vec<String>,
    },
    /// Failed before its mocks were known.
    Failed(Vec<Error>),
}

/// Everything a run found before writing.
#[derive(Debug, Default)]
pub struct Analysis {
    /// Config-level errors: authenticators, injectors, rules, duplicates, names.
    pub config_errors: Vec<Error>,
    /// Information lines: rules that apply to no module.
    pub notes: Vec<String>,
    pub modules: Vec<ModuleResult>,
}

impl Analysis {
    /// Every error that fails a run: config-level ones, then those of modules in scope.
    #[must_use]
    pub fn fatal(&self) -> Vec<&Error> {
        let mut errors: Vec<&Error> = self.config_errors.iter().collect();
        for module in &self.modules {
            if !module.in_scope {
                continue;
            }
            match &module.status {
                Status::Mocks { errors: found, .. } | Status::Failed(found) => {
                    errors.extend(found.iter());
                }
                _ => {}
            }
        }
        errors
    }

    /// The plans to write, in expansion order.
    #[must_use]
    pub fn plans(&self) -> Vec<&MockPlan> {
        self.modules
            .iter()
            .filter(|module| module.in_scope)
            .flat_map(|module| match &module.status {
                Status::Mocks { plans, .. } => plans.iter().collect(),
                _ => Vec::new(),
            })
            .collect()
    }
}

/// A resolved non-`caller` authenticator.
struct AuthPlan {
    prefix: String,
    file: PathBuf,
    call: String,
    slot: Option<SaltSlot>,
    params: Vec<String>,
}

/// A resolved injector.
struct InjectPlan {
    prefix: String,
    file: PathBuf,
    call: String,
    ty: (FileId, String),
    scope: InjectScope,
    params: Vec<String>,
}

/// Validated `[mock.auth]`, `[mock.inject]` and `caller_type`.
struct Context {
    caller: Option<(FileId, String)>,
    auths: BTreeMap<String, AuthPlan>,
    injectors: BTreeMap<String, InjectPlan>,
}

/// Validates the config against the sources, expands every selected module, and plans
/// the mocks `scope` selects.
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "candidates, rule checks, then planning, in order"
)]
pub fn analyze(config: &Config, files: &mut Files, scope: Scope<'_>) -> Analysis {
    let mut analysis = Analysis::default();
    let context = match context(config, files) {
        Ok(context) => context,
        Err(errors) => {
            analysis.config_errors = errors;
            return analysis;
        }
    };
    let candidates = match select::candidates(config) {
        Ok(candidates) => candidates,
        Err(error) => {
            analysis.config_errors.push(error.into());
            return analysis;
        }
    };
    let src_shown = files.paths().show(&config.src);
    analysis.notes.extend(
        select::unused_rules(config, &candidates, &src_shown)
            .iter()
            .chain(&select::unused_excludes(config, &candidates))
            .map(ToString::to_string),
    );

    let mut expanded: Vec<(usize, Expanded)> = Vec::new();
    for candidate in &candidates {
        let mut in_scope = scope.covers(&candidate.file);
        let status = match select::select(config, &candidate.module) {
            Selection::Excluded => Status::Excluded,
            Selection::Unmatched => Status::Unmatched,
            Selection::Selected(rules) => match expand(config, files, &context, candidate, rules) {
                Ok(Expansion::Skipped(reason)) => Status::Skipped(reason),
                Ok(Expansion::Mocks(mut module)) => {
                    let names = module.mocks.iter().map(|mock| mock.name.clone()).collect();
                    let circuits = module
                        .surface
                        .circuits
                        .iter()
                        .map(|circuit| SurfaceCircuit {
                            name: circuit.name().to_owned(),
                            at: circuit.at(),
                        })
                        .collect();
                    let errors = std::mem::take(&mut module.errors);
                    expanded.push((analysis.modules.len(), module));
                    Status::Mocks {
                        names,
                        artifacts: config.artifacts_dir(&candidate.module),
                        plans: Vec::new(),
                        circuits,
                        errors,
                        warnings: Vec::new(),
                    }
                }
                Err(errors) => Status::Failed(errors),
            },
        };
        if !scope.only.is_empty() {
            let artifacts = config.artifacts_dir(&candidate.module);
            let mut sources: Vec<PathBuf> = vec![candidate.file.clone()];
            if let Status::Mocks { names, .. } = &status {
                sources.extend(
                    names
                        .iter()
                        .map(|name| artifacts.join(format!("{name}.compact"))),
                );
            }
            let sources: Vec<&Path> = sources.iter().map(PathBuf::as_path).collect();
            in_scope = in_scope && scope.keeps(&sources, files.paths());
        }
        analysis.modules.push(ModuleResult {
            module: candidate.module.clone(),
            file: candidate.file.clone(),
            in_scope,
            status,
        });
    }

    let mut found = Vec::new();
    check_rules(config, &analysis, &expanded, &mut found);
    check_duplicates(config, &analysis, &mut found);
    check_names(config, &analysis, scope.names, &mut found);
    analysis.config_errors.append(&mut found);

    for (index, module) in &expanded {
        if !analysis.modules[*index].in_scope {
            continue;
        }
        let mut plans = Vec::new();
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let source = config.module_file(&module.module);
        let artifacts = config.artifacts_dir(&module.module);
        for spec in &module.mocks {
            if !scope.names.is_empty() && !scope.names.contains(&spec.name) {
                continue;
            }
            let mock = artifacts.join(format!("{}.compact", spec.name));
            if !scope.keeps(&[&source, &mock], files.paths()) {
                continue;
            }
            let mut planner = Planner::new(config, files, &context, module, spec);
            let result = planner.plan();
            let mut found = std::mem::take(&mut planner.errors);
            warnings.append(&mut planner.warnings);
            match result {
                Ok(plan) if found.is_empty() => plans.push(plan),
                Ok(_) => errors.append(&mut found),
                Err(error) => {
                    errors.append(&mut found);
                    errors.push(error);
                }
            }
        }
        if let Status::Mocks {
            plans: slot,
            errors: existing,
            warnings: lines,
            ..
        } = &mut analysis.modules[*index].status
        {
            *slot = plans;
            existing.append(&mut errors);
            *lines = warnings;
        }
    }
    analysis
}

fn context(config: &Config, files: &mut Files) -> Result<Context, Vec<Error>> {
    let mut errors: Vec<Error> = Vec::new();
    let caller = match &config.caller_type {
        Some(ty) => match type_decl(config, files, &ty.module, &ty.name, false) {
            Ok(Some(decl)) => Some(decl),
            Ok(None) => {
                errors.push(
                    AuthError::CallerType {
                        module: ty.module.clone(),
                        name: ty.name.clone(),
                    }
                    .into(),
                );
                None
            }
            Err(error) => {
                errors.push(error.into());
                None
            }
        },
        None => None,
    };
    let mut auths = BTreeMap::new();
    for spec in config.auths.values() {
        if spec.is_caller() {
            continue;
        }
        match auth_plan(config, files, spec, caller.as_ref()) {
            Ok(Some(plan)) => {
                auths.insert(spec.name.clone(), plan);
            }
            Ok(None) => {}
            Err(error) => errors.push(error),
        }
    }
    let mut injectors = BTreeMap::new();
    for spec in config.injectors.values() {
        match inject_plan(config, files, spec) {
            Ok(plan) => {
                injectors.insert(spec.name.clone(), plan);
            }
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() {
        Ok(Context {
            caller,
            auths,
            injectors,
        })
    } else {
        Err(errors)
    }
}

/// The struct or `new type` (or enum, when `enums`) `name` that `module` declares.
fn type_decl(
    config: &Config,
    files: &mut Files,
    module: &str,
    name: &str,
    enums: bool,
) -> Result<Option<(FileId, String)>, SourceError> {
    let id = files.require(&config.module_file(module))?;
    let source = files.get(id);
    let declares = source.module.as_ref().is_some_and(|module| {
        module.items.iter().any(|item| match item {
            Item::Type(decl) if decl.name == name => match &decl.kind {
                crate::source::TypeKind::Struct => true,
                crate::source::TypeKind::Enum => enums,
                crate::source::TypeKind::Alias { nominal, .. } => *nominal,
            },
            _ => false,
        })
    });
    Ok(declares.then(|| (id, name.to_owned())))
}

/// The leading identifier of a call template.
fn call_head(call: &str) -> String {
    call.chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '$')
        .collect()
}

/// The exported circuit `name` of the module in `file`, with the file that declares it.
fn exported_circuit(
    files: &mut Files,
    file: FileId,
    name: &str,
) -> Result<Option<(FileId, Circuit)>, SourceError> {
    for circuit in surface(files, file)?.circuits {
        if circuit.name() != name {
            continue;
        }
        return Ok(match circuit {
            Exposable::Own(circuit) => Some((file, circuit)),
            Exposable::Listed { decl, .. } => files.circuit(&decl).map(|found| (decl.file, found)),
        });
    }
    Ok(None)
}

fn auth_plan(
    config: &Config,
    files: &mut Files,
    spec: &AuthSpec,
    caller: Option<&(FileId, String)>,
) -> Result<Option<AuthPlan>, Error> {
    let (Some(module_path), Some(call), Some(caller)) = (&spec.module, &spec.call, caller) else {
        return Ok(None);
    };
    let file = config.module_file(module_path);
    let id = files.require(&file)?;
    let source = files.get(id);
    let module = single_module(&source, files)?;
    let head = call_head(call);
    let Some((declaring, circuit)) = exported_circuit(files, id, &head)? else {
        return Err(AuthError::Call {
            name: spec.name.clone(),
            circuit: head,
            module: module_path.clone(),
        }
        .into());
    };
    if files.caller_match(declaring, &circuit.generics, &circuit.ret, caller)? != CallerMatch::Exact
    {
        return Err(AuthError::Returns {
            name: spec.name.clone(),
            circuit: head,
            ty: circuit.ret.clone(),
            caller: caller.1.clone(),
        }
        .into());
    }
    Ok(Some(AuthPlan {
        prefix: spec
            .prefix
            .clone()
            .unwrap_or_else(|| format!("{}_", module.name)),
        file,
        call: call.clone(),
        slot: spec.slot(),
        params: spec.params.clone(),
    }))
}

fn inject_plan(config: &Config, files: &mut Files, spec: &InjectSpec) -> Result<InjectPlan, Error> {
    let Some(ty) = type_decl(config, files, &spec.ty.module, &spec.ty.name, true)? else {
        return Err(AuthError::InjectType {
            name: spec.name.clone(),
            module: spec.ty.module.clone(),
            ty: spec.ty.name.clone(),
        }
        .into());
    };
    let file = config.module_file(&spec.module);
    let id = files.require(&file)?;
    let source = files.get(id);
    let module = single_module(&source, files)?;
    let head = call_head(&spec.call);
    let Some((declaring, circuit)) = exported_circuit(files, id, &head)? else {
        return Err(AuthError::InjectCall {
            name: spec.name.clone(),
            circuit: head,
            module: spec.module.clone(),
        }
        .into());
    };
    if files.caller_match(declaring, &circuit.generics, &circuit.ret, &ty)? != CallerMatch::Exact {
        return Err(AuthError::InjectReturns {
            name: spec.name.clone(),
            circuit: head,
            ty: circuit.ret.clone(),
            target: spec.ty.name.clone(),
        }
        .into());
    }
    Ok(InjectPlan {
        prefix: spec
            .prefix
            .clone()
            .unwrap_or_else(|| format!("{}_", module.name)),
        file,
        call: spec.call.clone(),
        ty,
        scope: spec.scope,
        params: spec.params.clone(),
    })
}

/// Whether `file` holds a module that exports no circuit. `false` when it does not parse
/// or holds no module.
#[must_use]
pub fn exports_no_circuit(files: &mut Files, file: &Path) -> bool {
    let Ok(id) = files.require(file) else {
        return false;
    };
    if files.get(id).module.is_none() {
        return false;
    }
    surface(files, id).is_ok_and(|found| found.circuits.is_empty())
}

/// The file's only module, or the module-count error.
fn single_module<'a>(
    source: &'a SourceFile,
    files: &Files,
) -> Result<&'a crate::source::Module, SourceError> {
    match (&source.module, source.module_count) {
        (Some(module), 1) => Ok(module),
        (_, count) => Err(SourceError::ModuleCount {
            path: files.paths().show(&source.path),
            count,
        }),
    }
}

/// An exported circuit of the module: declared in it, or re-exported by its export list.
#[derive(Clone, Debug)]
enum Exposable {
    Own(Circuit),
    Listed {
        name: String,
        decl: Decl,
        at: Position,
    },
}

impl Exposable {
    fn name(&self) -> &str {
        match self {
            Self::Own(circuit) => &circuit.name,
            Self::Listed { name, .. } => name,
        }
    }

    const fn at(&self) -> Position {
        match self {
            Self::Own(circuit) => circuit.at,
            Self::Listed { at, .. } => *at,
        }
    }
}

/// The module's exported circuits and exported ledger fields, in module order.
#[derive(Clone, Debug, Default)]
struct Surface {
    circuits: Vec<Exposable>,
    ledgers: Vec<String>,
}

fn surface(files: &mut Files, file: FileId) -> Result<Surface, SourceError> {
    let source = files.get(file);
    let mut found = Surface::default();
    let Some(module) = source.module.as_ref() else {
        return Ok(found);
    };
    for item in &module.items {
        match item {
            Item::Circuit(circuit) if circuit.exported => {
                found.circuits.push(Exposable::Own(circuit.clone()));
            }
            Item::Ledger(ledger) if ledger.exported && !found.ledgers.contains(&ledger.name) => {
                found.ledgers.push(ledger.name.clone());
            }
            Item::ExportList(names) => {
                for named in names {
                    let name = &named.name;
                    let resolved = files.resolve(file, &[], name)?;
                    if let Some(Lookup::Missing(missing)) = resolved.lookup() {
                        return Err(files.missing_error(missing));
                    }
                    let Some(decl) = resolved.decl() else {
                        continue;
                    };
                    match decl.kind {
                        DeclKind::Ledger if !found.ledgers.contains(name) => {
                            found.ledgers.push(name.clone());
                        }
                        DeclKind::Circuit
                            if found.circuits.iter().all(|known| known.name() != name) =>
                        {
                            if let Resolved::Local(_) = resolved {
                                if let Some(circuit) = files.circuit(decl) {
                                    found.circuits.push(Exposable::Own(circuit));
                                }
                            } else {
                                found.circuits.push(Exposable::Listed {
                                    name: name.clone(),
                                    decl: decl.clone(),
                                    at: named.at,
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(found)
}

/// One mock a module expands to.
#[derive(Clone, Debug)]
struct MockSpec {
    name: String,
    /// The authenticator, or `None` for a module without a caller parameter.
    auth: Option<String>,
    merged: bool,
    instances: Vec<InstanceSpec>,
    settings: Settings,
}

/// One module instance inside a mock.
#[derive(Clone, Debug)]
struct InstanceSpec {
    /// The suffix as configured, for messages and merged names.
    suffix: String,
    prefix: String,
    module_args: Vec<String>,
    circuit_args: BTreeMap<String, Vec<String>>,
    init: Init,
    salt: Option<Salt>,
    exclude: Vec<String>,
    rename: BTreeMap<String, String>,
}

/// A selected module, read and expanded.
struct Expanded {
    module: String,
    file: FileId,
    surface: Surface,
    rules: Vec<usize>,
    /// No applicable rule lists the module's exact path: a generic circuit without
    /// `circuit_args` is skipped with a warning instead of failing the mock.
    lenient: bool,
    mocks: Vec<MockSpec>,
    errors: Vec<Error>,
}

enum Expansion {
    Skipped(SkipReason),
    Mocks(Expanded),
}

/// One group of instances: a stand-alone instance or a merged group.
struct Group {
    name: String,
    merged: bool,
    members: Vec<config::Instance>,
}

fn groups(folded: &Folded) -> Vec<Group> {
    let Some(instances) = &folded.instances else {
        return vec![Group {
            name: String::new(),
            merged: false,
            members: vec![config::Instance::default()],
        }];
    };
    if folded.merge {
        return vec![Group {
            name: String::new(),
            merged: true,
            members: instances.clone(),
        }];
    }
    let mut groups: Vec<Group> = Vec::new();
    for instance in instances {
        match &instance.group {
            None => groups.push(Group {
                name: instance.suffix.clone(),
                merged: false,
                members: vec![instance.clone()],
            }),
            Some(group) => match groups
                .iter_mut()
                .find(|known| known.merged && &known.name == group)
            {
                Some(known) => known.members.push(instance.clone()),
                None => groups.push(Group {
                    name: group.clone(),
                    merged: true,
                    members: vec![instance.clone()],
                }),
            },
        }
    }
    groups
}

/// `{dir}`: each segment with its first letter upper-cased, joined with nothing.
fn dir_camel(module: &str) -> String {
    module_dir(module)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut chars = segment.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect()
}

#[allow(
    clippy::too_many_lines,
    reason = "expansion reads best as one pass in rule order"
)]
fn expand(
    config: &Config,
    files: &mut Files,
    context: &Context,
    candidate: &Candidate,
    rules: Vec<usize>,
) -> Result<Expansion, Vec<Error>> {
    let id = files
        .require(&candidate.file)
        .map_err(|error| vec![error.into()])?;
    let source = files.get(id);
    if source.module.is_none() {
        return Ok(Expansion::Skipped(SkipReason::NotAModule));
    }
    let module = single_module(&source, files).map_err(|error| vec![error.into()])?;
    let surface = surface(files, id).map_err(|error| vec![error.into()])?;
    if surface.circuits.is_empty() {
        return Ok(Expansion::Skipped(SkipReason::NoExportedCircuits));
    }
    if source.pragma.is_none() {
        return Err(vec![
            SourceError::NoPragma {
                path: files.paths().show(&candidate.file),
            }
            .into(),
        ]);
    }

    let folded = config::fold(config, &rules);
    let lenient = !rules
        .iter()
        .any(|&index| config.rules[index].names(&candidate.module));
    if lenient && let Some(reason) = generic_gap(module, &surface, &folded) {
        return Ok(Expansion::Skipped(reason));
    }
    let stem = module_stem(&candidate.module);
    let mut errors: Vec<Error> = Vec::new();
    let has_caller = match &context.caller {
        Some(caller) => scan_callers(files, id, &surface, caller, stem, &mut errors)
            .map_err(|error| vec![error.into()])?,
        None => false,
    };
    let auths: Vec<Option<&AuthSpec>> = if has_caller {
        folded
            .auth
            .iter()
            .filter_map(|name| config.auths.get(name))
            .map(Some)
            .collect()
    } else {
        vec![None]
    };

    let decl_prefix = format!("{}_", module.name);
    let mut mocks = Vec::new();
    for group in groups(&folded) {
        for auth in &auths {
            let settings = match auth {
                Some(auth) => config::settings_for(config, &rules, &folded.settings, &auth.name),
                None => folded.settings.clone(),
            };
            let suffix = auth.map_or("", |auth| auth.suffix.as_str());
            let name = folded
                .name
                .replace("{module}", stem)
                .replace("{instance}", &group.name)
                .replace("{suffix}", suffix)
                .replace("{dir}", &dir_camel(&candidate.module));
            if !is_name(&name) {
                errors.push(
                    ConfigError::NameIdentifier {
                        cfg: config.shown.clone(),
                        template: folded.name.clone(),
                        value: name.clone(),
                        module: candidate.module.clone(),
                    }
                    .into(),
                );
                continue;
            }
            let instances = group
                .members
                .iter()
                .map(|instance| InstanceSpec {
                    suffix: instance.suffix.clone(),
                    prefix: instance.prefix.clone().unwrap_or_else(|| {
                        if group.merged {
                            format!("{}{}_", module.name, instance.suffix)
                        } else {
                            folded.prefix.clone().unwrap_or_else(|| decl_prefix.clone())
                        }
                    }),
                    module_args: instance
                        .module_args
                        .clone()
                        .unwrap_or_else(|| folded.module_args.clone()),
                    circuit_args: instance
                        .circuit_args
                        .clone()
                        .unwrap_or_else(|| folded.circuit_args.clone()),
                    init: instance
                        .init
                        .clone()
                        .or_else(|| settings.init.clone())
                        .unwrap_or(Init::Auto),
                    salt: instance.salt.clone().or_else(|| settings.salt.clone()),
                    exclude: instance
                        .exclude
                        .clone()
                        .or_else(|| settings.exclude.clone())
                        .unwrap_or_default(),
                    rename: instance
                        .rename
                        .clone()
                        .or_else(|| settings.rename.clone())
                        .unwrap_or_default(),
                })
                .collect();
            mocks.push(MockSpec {
                name,
                auth: auth.map(|auth| auth.name.clone()),
                merged: group.merged,
                instances,
                settings,
            });
        }
    }

    Ok(Expansion::Mocks(Expanded {
        module: candidate.module.clone(),
        file: id,
        surface,
        rules,
        lenient,
        mocks,
        errors,
    }))
}

/// Why a module only a glob selects cannot be mocked as configured: it is generic and
/// no instance gets `module_args`, or an instance's constructor would call a generic init
/// circuit without `circuit_args`. Per-authenticator `init` tables are not consulted.
fn generic_gap(
    module: &crate::source::Module,
    surface: &Surface,
    folded: &Folded,
) -> Option<SkipReason> {
    let default = config::Instance::default();
    let instances: Vec<&config::Instance> = match &folded.instances {
        Some(instances) => instances.iter().collect(),
        None => vec![&default],
    };
    let module_args = |instance: &config::Instance| {
        instance
            .module_args
            .as_ref()
            .unwrap_or(&folded.module_args)
            .clone()
    };
    if !module.generics.is_empty()
        && instances
            .iter()
            .all(|instance| module_args(instance).is_empty())
    {
        return Some(SkipReason::GenericModule);
    }
    let generic_init = instances.iter().any(|instance| {
        let init = instance
            .init
            .as_ref()
            .or(folded.settings.init.as_ref())
            .unwrap_or(&Init::Auto);
        let args = instance
            .circuit_args
            .as_ref()
            .unwrap_or(&folded.circuit_args);
        !matches!(init, Init::None)
            && !args.contains_key(init.circuit())
            && surface.circuits.iter().any(|circuit| {
                matches!(circuit, Exposable::Own(own)
                    if own.name == init.circuit() && !own.generics.is_empty())
            })
    });
    generic_init.then_some(SkipReason::GenericInit)
}

/// Whether any exported circuit takes the caller type. Parameter types that do not
/// resolve are reported against the module stem.
fn scan_callers(
    files: &mut Files,
    id: FileId,
    surface: &Surface,
    caller: &(FileId, String),
    stem: &str,
    errors: &mut Vec<Error>,
) -> Result<bool, SourceError> {
    let mut has_caller = false;
    for circuit in &surface.circuits {
        let (file, circuit) = match circuit {
            Exposable::Own(circuit) => (id, circuit.clone()),
            Exposable::Listed { decl, .. } => match files.circuit(decl) {
                Some(circuit) => (decl.file, circuit),
                None => continue,
            },
        };
        for (position, param) in circuit.params.iter().enumerate() {
            match files.caller_match(file, &circuit.generics, &param.ty, caller)? {
                CallerMatch::Exact | CallerMatch::Contains => has_caller = true,
                CallerMatch::Unresolved => errors.push(
                    PlanError::Unresolved {
                        mock: format!("Mock{stem}"),
                        param: param_label(param.name(), position),
                        circuit: circuit.name.clone(),
                        ty: param.ty.clone(),
                    }
                    .into(),
                ),
                CallerMatch::No => {}
            }
        }
    }
    Ok(has_caller)
}

fn param_label(name: Option<&str>, position: usize) -> String {
    name.map_or_else(|| (position + 1).to_string(), str::to_owned)
}

/// The circuit name a `rename` key names: `name` or `name(T1, T2)`.
fn rename_circuit(key: &str) -> &str {
    key.split_once('(').map_or(key, |(name, _)| name.trim())
}

/// Rule-level checks: every circuit or ledger field a rule names is exported by at least
/// one module it applies to. A rule with an unreadable module is not checked.
#[allow(
    clippy::too_many_lines,
    reason = "one pass over each rule's keys reads best as one function"
)]
fn check_rules(
    config: &Config,
    analysis: &Analysis,
    expanded: &[(usize, Expanded)],
    errors: &mut Vec<Error>,
) {
    for (index, rule) in config.rules.iter().enumerate() {
        let mut circuits: BTreeSet<&str> = BTreeSet::new();
        let mut ledgers: BTreeSet<&str> = BTreeSet::new();
        let mut owned_init: BTreeSet<&str> = BTreeSet::new();
        let mut complete = true;
        let mut planned = false;
        for (position, module) in analysis.modules.iter().enumerate() {
            if !rule.applies(&module.module) {
                continue;
            }
            match &module.status {
                Status::Failed(_) => complete = false,
                Status::Mocks { .. } => {
                    if let Some((_, found)) = expanded.iter().find(|(at, _)| *at == position) {
                        if !found.rules.contains(&index) {
                            continue;
                        }
                        planned = true;
                        for circuit in &found.surface.circuits {
                            circuits.insert(circuit.name());
                            if let Exposable::Own(own) = circuit {
                                owned_init.insert(&own.name);
                            }
                        }
                        ledgers.extend(found.surface.ledgers.iter().map(String::as_str));
                    }
                }
                _ => {}
            }
        }
        // Only modules the rule still applies to after every exclusion count, and a rule
        // with none of them names nothing that could be checked.
        if !complete || !planned {
            continue;
        }
        let mut named: Vec<(&str, String)> = Vec::new();
        let mut ledger_names: Vec<String> = Vec::new();
        let mut inits: Vec<Init> = Vec::new();
        let mut collect = |settings: &Settings| {
            for name in settings.exclude.iter().flatten() {
                named.push(("exclude", name.clone()));
            }
            for name in settings.disclose.iter().flatten() {
                named.push(("disclose", name.clone()));
            }
            if let Some(Guard::Some(list)) = &settings.guard {
                for name in list {
                    named.push(("guard", name.clone()));
                }
            }
            for key in settings.rename.iter().flat_map(BTreeMap::keys) {
                named.push(("rename", rename_circuit(key).to_owned()));
            }
            if let Some(Ledger::Some(list)) = &settings.ledger {
                ledger_names.extend(list.iter().cloned());
            }
            if let Some(init) = &settings.init
                && init.explicit()
            {
                inits.push(init.clone());
            }
        };
        collect(&rule.settings);
        for table in rule.overrides.values() {
            collect(table);
        }
        for instance in rule.instances.iter().flatten() {
            for name in instance.exclude.iter().flatten() {
                named.push(("exclude", name.clone()));
            }
            for key in instance.rename.iter().flat_map(BTreeMap::keys) {
                named.push(("rename", rename_circuit(key).to_owned()));
            }
            for key in instance.circuit_args.iter().flat_map(BTreeMap::keys) {
                named.push(("circuit_args", key.clone()));
            }
            if let Some(init) = &instance.init
                && init.explicit()
            {
                inits.push(init.clone());
            }
        }
        for key in rule.circuit_args.iter().flat_map(BTreeMap::keys) {
            named.push(("circuit_args", key.clone()));
        }
        let mut reported: BTreeSet<(String, String)> = BTreeSet::new();
        for (key, circuit) in named {
            if !circuits.contains(circuit.as_str())
                && reported.insert((key.to_owned(), circuit.clone()))
            {
                errors.push(
                    ConfigError::RuleCircuit {
                        cfg: config.shown.clone(),
                        number: rule.number,
                        key: key.to_owned(),
                        circuit,
                    }
                    .into(),
                );
            }
        }
        for field in ledger_names {
            if !ledgers.contains(field.as_str())
                && reported.insert(("ledger".to_owned(), field.clone()))
            {
                errors.push(
                    ConfigError::RuleLedger {
                        cfg: config.shown.clone(),
                        number: rule.number,
                        field,
                    }
                    .into(),
                );
            }
        }
        for init in inits {
            let circuit = init.circuit().to_owned();
            if !owned_init.contains(circuit.as_str())
                && reported.insert(("init".to_owned(), circuit.clone()))
            {
                errors.push(
                    ConfigError::RuleInit {
                        cfg: config.shown.clone(),
                        number: rule.number,
                        init: init.to_string(),
                        circuit,
                    }
                    .into(),
                );
            }
        }
    }
}

/// Mock names are unique ignoring ASCII case, across the whole expansion.
fn check_duplicates(config: &Config, analysis: &Analysis, errors: &mut Vec<Error>) {
    let mut seen: HashMap<String, (&str, &str)> = HashMap::new();
    for module in &analysis.modules {
        let Status::Mocks { names, .. } = &module.status else {
            continue;
        };
        for name in names {
            match seen.get(&name.to_ascii_lowercase()) {
                Some((_, first)) => errors.push(
                    ConfigError::DuplicateName {
                        cfg: config.shown.clone(),
                        mock: name.clone(),
                        first: (*first).to_owned(),
                        second: module.module.clone(),
                    }
                    .into(),
                ),
                None => {
                    seen.insert(name.to_ascii_lowercase(), (name, &module.module));
                }
            }
        }
    }
}

/// A NAME argument must name a mock of the expansion. Unknown only when every module
/// expanded, since a failed one may hold it.
fn check_names(config: &Config, analysis: &Analysis, names: &[String], errors: &mut Vec<Error>) {
    let complete = analysis
        .modules
        .iter()
        .all(|module| !matches!(module.status, Status::Failed(_)));
    if !complete {
        return;
    }
    for name in names {
        let known = analysis.modules.iter().any(|module| match &module.status {
            Status::Mocks { names: found, .. } => found.contains(name),
            _ => false,
        });
        if !known {
            errors.push(
                ConfigError::UnknownName {
                    name: name.clone(),
                    cfg: config.shown.clone(),
                }
                .into(),
            );
        }
    }
}

/// Imports the emitted text depends on.
#[derive(Default)]
struct Needs {
    /// Selective elements, as (file, import, element).
    elements: BTreeSet<(FileId, usize, usize)>,
    /// Prefixed and whole-module imports, as (file, import).
    imports: BTreeSet<(FileId, usize)>,
    /// Files whose imports were needed, in first-use order.
    order: Vec<FileId>,
    /// Instances whose prefix some emitted text names.
    prefixes: BTreeSet<usize>,
}

impl Needs {
    fn touch(&mut self, file: FileId) {
        if !self.order.contains(&file) {
            self.order.push(file);
        }
    }
}

/// The scope a type is written in.
struct TypeScope<'a> {
    file: FileId,
    generics: &'a [GenericParam],
    circuit_args: &'a [String],
    circuit: &'a str,
}

/// What a mock collects across its instances before the plan is assembled.
#[derive(Default)]
struct Assembly {
    types: BTreeSet<String>,
    reexports: Vec<String>,
    plain_ledgers: Vec<String>,
    pure_exports: Vec<String>,
    ledger_exports: Vec<String>,
    wrappers: Vec<Wrapper>,
    params: Vec<(Param, String)>,
    flags: Vec<String>,
    calls: Vec<(Option<String>, Call)>,
    has_constructor: bool,
    covered: BTreeSet<usize>,
    /// Every name the mock declares, with what declares it and an identity, for the
    /// clash check. One identity may claim its name twice.
    taken: Vec<(String, String, String)>,
    /// Identities of wrappers whose name is not their circuit's: renamed, overload
    /// numbered or merged.
    renamed: BTreeSet<String>,
    /// Each exposed circuit's parameters after injection, for `implements`.
    signatures: BTreeMap<String, Signature>,
}

/// The parameters an exposed circuit keeps, as its declaring file writes them.
struct Signature {
    file: FileId,
    types: Vec<String>,
    /// As the mock spells them, for messages.
    shown: Vec<String>,
    /// Types under `circuit_args` are not compared.
    generic: bool,
}

/// The authenticator call of one instance: not yet computed, failed (its salt error is
/// reported once), or ready.
#[derive(Clone, Debug)]
enum AuthExpr {
    Pending,
    Failed,
    Ready(String),
}

struct Planner<'a> {
    config: &'a Config,
    files: &'a mut Files,
    module: &'a Expanded,
    spec: &'a MockSpec,
    caller: Option<&'a (FileId, String)>,
    auth: Option<&'a AuthPlan>,
    injectors: Vec<&'a InjectPlan>,
    errors: Vec<Error>,
    /// Lines that do not fail the run: circuits skipped under a glob.
    warnings: Vec<String>,
    needs: Needs,
    current: usize,
    /// Per instance: the authenticator call once computed.
    auth_exprs: Vec<AuthExpr>,
    used_auth: bool,
    used_injectors: BTreeSet<usize>,
}

impl<'a> Planner<'a> {
    fn new(
        config: &'a Config,
        files: &'a mut Files,
        context: &'a Context,
        module: &'a Expanded,
        spec: &'a MockSpec,
    ) -> Self {
        let auth = spec
            .auth
            .as_ref()
            .filter(|name| name.as_str() != CALLER)
            .and_then(|name| context.auths.get(name));
        let injectors = spec
            .settings
            .inject
            .iter()
            .flatten()
            .filter_map(|name| context.injectors.get(name))
            .collect();
        Self {
            config,
            files,
            module,
            spec,
            caller: context.caller.as_ref(),
            auth,
            injectors,
            errors: Vec::new(),
            warnings: Vec::new(),
            needs: Needs::default(),
            current: 0,
            auth_exprs: vec![AuthExpr::Pending; spec.instances.len()],
            used_auth: false,
            used_injectors: BTreeSet::new(),
        }
    }

    fn mock(&self) -> String {
        self.spec.name.clone()
    }

    fn report(&mut self, error: impl Into<Error>) {
        self.errors.push(error.into());
    }

    fn inst(&self) -> &'a InstanceSpec {
        &self.spec.instances[self.current]
    }

    fn artifacts(&self) -> PathBuf {
        self.config.artifacts_dir(&self.module.module)
    }

    fn plan(&mut self) -> Result<MockPlan, Error> {
        let file = self.module.file;
        let source = self.files.get(file);
        let module = source.module.clone().expect("expansion checked the module");
        self.check_module_args(&module)?;

        let mut assembly = Assembly::default();
        for index in 0..self.spec.instances.len() {
            self.current = index;
            self.instance(&mut assembly)?;
        }
        if assembly.wrappers.iter().any(|wrapper| wrapper.guard) {
            assembly.taken.push((
                GUARD_LEDGER.to_owned(),
                format!("ledger {GUARD_LEDGER}"),
                "guard".to_owned(),
            ));
        }

        let (include, fragment_exports, fragment_constructor) = self.include()?;
        if fragment_constructor && assembly.has_constructor {
            let path = self.fragment_path();
            self.report(PlanError::FragmentConstructor {
                mock: self.mock(),
                path: self.files.paths().show(&path),
            });
        }
        for (index, circuit) in self.module.surface.circuits.iter().enumerate() {
            let init = fragment_constructor
                && matches!(circuit, Exposable::Own(_))
                && self
                    .spec
                    .instances
                    .iter()
                    .any(|inst| inst.init.circuit() == circuit.name());
            if init || fragment_exports.iter().any(|name| name == circuit.name()) {
                assembly.covered.insert(index);
            }
        }
        if include.is_some() {
            self.needs.prefixes.extend(0..self.spec.instances.len());
        }

        let (interfaces, implements) = self.implements(&assembly, &fragment_exports)?;
        let (named, prefixed) = self.imports(&module, &assembly)?;
        let named = without_interfaces(named, &interfaces);
        let fragment = include.is_some().then(|| self.fragment_path());
        self.check_witnesses(&interfaces, &named, &prefixed, fragment.as_deref());
        self.check_clashes(&assembly, &named);

        let constructor = assembly.has_constructor.then(|| Constructor {
            params: assembly
                .params
                .iter()
                .map(|(param, _)| param.clone())
                .collect(),
            flags: assembly.flags.clone(),
            calls: assembly.calls.clone(),
        });
        let guard_ledger = assembly.wrappers.iter().any(|wrapper| wrapper.guard);
        let mut exports: Vec<String> = assembly.types.into_iter().collect();
        exports.extend(assembly.reexports);
        exports.extend(assembly.pure_exports);
        exports.extend(assembly.ledger_exports);
        let mut seen = BTreeSet::new();
        exports.retain(|name| seen.insert(name.clone()));

        let artifacts = self.artifacts();
        Ok(MockPlan {
            name: self.spec.name.clone(),
            path: artifacts.join(format!("{}.compact", self.spec.name)),
            artifacts,
            module: self.module.module.clone(),
            spdx: self.config.spdx.clone(),
            pragma: source.pragma.clone().unwrap_or_default(),
            interfaces,
            named,
            prefixed,
            implements,
            exports,
            guard_ledger,
            constructor,
            wrappers: assembly.wrappers,
            include,
            covered: assembly.covered,
        })
    }

    /// Module argument arity per instance, the caller in a module argument, and two
    /// instances of one merged group sharing their arguments.
    fn check_module_args(&mut self, module: &crate::source::Module) -> Result<(), Error> {
        let takes = module.generics.len();
        let mut seen: Vec<(String, String)> = Vec::new();
        for index in 0..self.spec.instances.len() {
            let inst = &self.spec.instances[index];
            if takes > 0 && inst.module_args.is_empty() {
                self.report(PlanError::GenericModule {
                    mock: self.mock(),
                    module: self.module.module.clone(),
                    count: takes,
                });
            } else if inst.module_args.len() != takes {
                self.report(PlanError::ModuleArgsCount {
                    mock: self.mock(),
                    given: inst.module_args.len(),
                    module: self.module.module.clone(),
                    takes,
                });
            }
            if let Some(caller) = self.caller {
                for arg in &inst.module_args {
                    let matched = self
                        .files
                        .caller_match(self.module.file, &[], arg, caller)?;
                    if matches!(matched, CallerMatch::Exact | CallerMatch::Contains) {
                        self.report(PlanError::CallerModuleArgument {
                            mock: self.mock(),
                            arg: arg.clone(),
                            caller: caller.1.clone(),
                        });
                    }
                }
            }
            for (name, args) in &inst.circuit_args {
                let takes = self
                    .module
                    .surface
                    .circuits
                    .iter()
                    .find(|circuit| circuit.name() == name)
                    .map(|circuit| match circuit {
                        Exposable::Own(own) => own.generics.len(),
                        Exposable::Listed { decl, .. } => self
                            .files
                            .circuit(decl)
                            .map_or(0, |target| target.generics.len()),
                    });
                match takes {
                    Some(0) => self.report(PlanError::CircuitArgsNotGeneric {
                        mock: self.mock(),
                        circuit: name.clone(),
                    }),
                    Some(takes) if takes != args.len() => {
                        self.report(PlanError::CircuitArgsCount {
                            mock: self.mock(),
                            circuit: name.clone(),
                            given: args.len(),
                            takes,
                        });
                    }
                    _ => {}
                }
            }
            if self.spec.merged {
                let key: String = inst
                    .module_args
                    .iter()
                    .map(|arg| argument_key(arg))
                    .collect::<Vec<_>>()
                    .join(",");
                if let Some((first, _)) = seen.iter().find(|(_, args)| *args == key) {
                    self.report(PlanError::SameArgs {
                        mock: self.mock(),
                        instances: format!("{first} and {}", inst.suffix),
                        args: format!(
                            "{}; compactc would share one instance of {}",
                            generic_args_text(&inst.module_args),
                            self.module.module
                        ),
                    });
                }
                seen.push((inst.suffix.clone(), key));
            }
        }
        Ok(())
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one instance in rule order reads best as one function"
    )]
    fn instance(&mut self, out: &mut Assembly) -> Result<(), Error> {
        let file = self.module.file;
        let inst = self.inst();
        let surface = &self.module.surface;
        let settings = &self.spec.settings;
        let merged = self.spec.merged;
        let disclose = settings.disclose.clone().unwrap_or_default();
        let guard_all = matches!(settings.guard, Some(Guard::All(true)));
        let guard_list = match &settings.guard {
            Some(Guard::Some(list)) => list.clone(),
            _ => Vec::new(),
        };

        // The constructor and the init circuit it consumes.
        let init_circuit = inst.init.circuit().to_owned();
        let own_inits: Vec<Circuit> = surface
            .circuits
            .iter()
            .filter_map(|circuit| match circuit {
                Exposable::Own(own) if own.name == init_circuit => Some(own.clone()),
                _ => None,
            })
            .collect();
        let constructs = !matches!(inst.init, Init::None) && !own_inits.is_empty();
        if constructs && own_inits.len() > 1 {
            self.report(PlanError::Overloaded {
                mock: self.mock(),
                module: self.module.module.clone(),
                count: own_inits.len(),
                circuit: init_circuit.clone(),
            });
        }

        // Overload counts and rename keys that pick no overload.
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for circuit in &surface.circuits {
            *counts.entry(circuit.name()).or_default() += 1;
        }
        for key in inst.rename.keys() {
            if key.contains('(') {
                let name = rename_circuit(key);
                let matches = surface.circuits.iter().any(|circuit| {
                    circuit.name() == name && self.signature_key(circuit).as_deref() == Some(key)
                });
                if counts.contains_key(name) && !matches {
                    self.report(PlanError::RenameOverload {
                        mock: self.mock(),
                        key: key.clone(),
                        circuit: name.to_owned(),
                    });
                }
            }
        }

        let mut ordinal: HashMap<&str, usize> = HashMap::new();
        for (index, circuit) in surface.circuits.iter().enumerate() {
            let count = counts[circuit.name()];
            let k = {
                let entry = ordinal.entry(circuit.name()).or_default();
                *entry += 1;
                *entry
            };
            // The constructor calls its init circuit whether or not `exclude` lists it.
            if constructs && matches!(circuit, Exposable::Own(own) if own.name == init_circuit) {
                out.covered.insert(index);
                continue;
            }
            if inst.exclude.iter().any(|name| name == circuit.name()) {
                continue;
            }
            let guarded = guard_all || guard_list.iter().any(|name| name == circuit.name());
            let disclosed = disclose.iter().any(|name| name == circuit.name());
            let signature = self.signature_key(circuit);
            let renamed = signature
                .as_ref()
                .and_then(|key| inst.rename.get(key))
                .or_else(|| (k == 1).then(|| inst.rename.get(circuit.name())).flatten())
                .cloned();
            let base = if count > 1 && k > 1 {
                format!("{}{k}", circuit.name())
            } else {
                circuit.name().to_owned()
            };
            let exposed_name = match (&renamed, merged) {
                (Some(target), _) => target.clone(),
                (None, true) => format!("{base}{}", inst.suffix),
                (None, false) => base,
            };

            let (declaring, target) = match circuit {
                Exposable::Own(own) => (file, Some(own.clone())),
                Exposable::Listed { decl, .. } => (decl.file, self.files.circuit(decl)),
            };
            let Some(target) = target else {
                out.covered.insert(index);
                out.reexports.push(circuit.name().to_owned());
                out.taken.push((
                    circuit.name().to_owned(),
                    format!("circuit {}", circuit.name()),
                    format!("circuit {}:{index}", self.current),
                ));
                continue;
            };
            let generic = !target.generics.is_empty();
            if generic && self.module.lenient && !inst.circuit_args.contains_key(circuit.name()) {
                self.warnings.push(format!(
                    "{}: skipped circuit {}: type parameters {} and no circuit_args",
                    self.mock(),
                    circuit.name(),
                    generics_text(&target.generics)
                ));
                continue;
            }
            out.covered.insert(index);
            let (inject, _) = self.injections(declaring, &target, false)?;
            let wraps = inject.iter().any(Option::is_some)
                || generic
                || disclosed
                || guarded
                || renamed.is_some()
                || count > 1
                || merged;
            if merged && target.pure && count == 1 {
                out.pure_exports
                    .push(format!("{}{}", inst.prefix, circuit.name()));
                out.taken.push((
                    format!("{}{}", inst.prefix, circuit.name()),
                    format!("pure circuit {}{}", inst.prefix, circuit.name()),
                    format!("pure {}:{index}", self.current),
                ));
                self.needs.prefixes.insert(self.current);
            }
            let own = declaring == file;
            if !wraps {
                let types: Vec<String> =
                    target.params.iter().map(|param| param.ty.clone()).collect();
                out.signatures.insert(
                    circuit.name().to_owned(),
                    Signature {
                        file: declaring,
                        shown: types.clone(),
                        types,
                        generic: false,
                    },
                );
                out.reexports.push(circuit.name().to_owned());
                out.taken.push((
                    circuit.name().to_owned(),
                    format!("circuit {}", circuit.name()),
                    format!("circuit {}:{index}", self.current),
                ));
                let scope = TypeScope {
                    file: declaring,
                    generics: &target.generics,
                    circuit_args: &[],
                    circuit: circuit.name(),
                };
                self.collect_signature(&scope, &target, &[], own, &mut out.types)?;
                continue;
            }
            if generic && !inst.circuit_args.contains_key(circuit.name()) {
                self.report(PlanError::GenericNoArgs {
                    mock: self.mock(),
                    circuit: circuit.name().to_owned(),
                    generics: generics_text(&target.generics),
                });
            }
            if disclosed && returns_unit(&target.ret) {
                self.report(PlanError::DiscloseUnit {
                    mock: self.mock(),
                    circuit: circuit.name().to_owned(),
                });
            }
            let args = inst
                .circuit_args
                .get(circuit.name())
                .cloned()
                .unwrap_or_default();
            self.check_caller_args(file, circuit.name(), &args, false)?;
            let scope = TypeScope {
                file: declaring,
                generics: &target.generics,
                circuit_args: &args,
                circuit: circuit.name(),
            };
            let (params, call_args) = self.forwarded(&scope, &target, &inject)?;
            if guarded && params.iter().any(|param| param.name == GUARD_LEDGER) {
                self.report(PlanError::GuardShadowed {
                    mock: self.mock(),
                    circuit: circuit.name().to_owned(),
                });
            }
            let ret = self.spell(&scope, &target.ret)?;
            let dropped: Vec<bool> = inject.iter().map(Option::is_some).collect();
            self.collect_signature(&scope, &target, &dropped, own, &mut out.types)?;
            self.needs.prefixes.insert(self.current);
            let identity = format!("circuit {}:{index}", self.current);
            if exposed_name != circuit.name() {
                out.renamed.insert(identity.clone());
            }
            out.taken.push((
                exposed_name.clone(),
                format!("circuit {exposed_name}"),
                identity,
            ));
            out.signatures.insert(
                exposed_name.clone(),
                Signature {
                    file: declaring,
                    types: target
                        .params
                        .iter()
                        .zip(&inject)
                        .filter(|(_, injected)| injected.is_none())
                        .map(|(param, _)| param.ty.clone())
                        .collect(),
                    shown: params.iter().map(|param| param.ty.clone()).collect(),
                    generic,
                },
            );
            out.wrappers.push(Wrapper {
                name: exposed_name,
                pure: target.pure && !inject.iter().any(Option::is_some) && !guarded,
                params,
                ret,
                guard: guarded,
                injected: inject.iter().filter(|slot| slot.is_some()).count(),
                disclose: disclosed,
                call: Call {
                    callee: format!(
                        "{}{}{}",
                        inst.prefix,
                        circuit.name(),
                        generic_args_text(&args)
                    ),
                    args: call_args,
                },
            });
        }

        if constructs && let Some(init) = own_inits.first() {
            self.constructor(init, out)?;
        }
        self.ledgers(out);
        Ok(())
    }

    /// `name(T1, T2)` for a circuit, from its written parameter types.
    fn signature_key(&self, circuit: &Exposable) -> Option<String> {
        let target = match circuit {
            Exposable::Own(own) => own.clone(),
            Exposable::Listed { decl, .. } => self.files.circuit(decl)?,
        };
        let types: Vec<String> = target
            .params
            .iter()
            .map(|param| collapse(&param.ty))
            .collect();
        Some(format!("{}({})", circuit.name(), types.join(", ")))
    }

    fn constructor(&mut self, init: &Circuit, out: &mut Assembly) -> Result<(), Error> {
        let file = self.module.file;
        let instance = self.inst();
        let (inject, caller_injected) = self.injections(file, init, true)?;
        // An unknown ledger field is reported once, as SaltLedger.
        let salt = match &instance.salt {
            Some(Salt::Ledger(field)) if self.module.surface.ledgers.contains(field) => {
                Some(format!("ledger field {field}"))
            }
            Some(Salt::Expr(expr)) => Some(format!("expression {expr}")),
            _ => None,
        };
        if let Some(salt) = salt
            && caller_injected
            && self.auth.is_some_and(|auth| auth.slot.is_some())
        {
            self.report(PlanError::SaltBeforeInit {
                mock: self.mock(),
                circuit: init.name.clone(),
                salt,
            });
        }
        if !init.generics.is_empty() && !instance.circuit_args.contains_key(&init.name) {
            self.report(PlanError::GenericInitialize {
                mock: self.mock(),
                circuit: init.name.clone(),
                generics: generics_text(&init.generics),
            });
        }
        let args = instance
            .circuit_args
            .get(&init.name)
            .cloned()
            .unwrap_or_default();
        self.check_caller_args(file, &init.name, &args, true)?;
        let scope = TypeScope {
            file,
            generics: &init.generics,
            circuit_args: &args,
            circuit: &init.name,
        };
        let (params, call_args) = self.forwarded(&scope, init, &inject)?;
        let dropped: Vec<bool> = inject.iter().map(Option::is_some).collect();
        self.collect_signature(&scope, init, &dropped, true, &mut out.types)?;
        self.needs.prefixes.insert(self.current);
        for param in params {
            match out
                .params
                .iter()
                .find(|(known, _)| known.name == param.name)
            {
                Some((known, first)) if known.ty != param.ty => {
                    let first = format!("{} in instance {first}", known.ty);
                    self.report(PlanError::CtorParamClash {
                        mock: self.mock(),
                        param: param.name.clone(),
                        first,
                        second: format!("{} in instance {}", param.ty, instance.suffix),
                    });
                }
                Some(_) => {}
                None => out.params.push((param, instance.suffix.clone())),
            }
        }
        let flag = instance.init.flag().map(str::to_owned);
        if let Some(flag) = &flag {
            if out.params.iter().any(|(param, _)| &param.name == flag) {
                self.report(PlanError::FlagClash {
                    mock: self.mock(),
                    flag: flag.clone(),
                });
            }
            if !out.flags.contains(flag) {
                out.flags.push(flag.clone());
            }
        }
        out.has_constructor = true;
        out.calls.push((
            flag,
            Call {
                callee: format!(
                    "{}{}{}",
                    instance.prefix,
                    init.name,
                    generic_args_text(&args)
                ),
                args: call_args,
            },
        ));
        Ok(())
    }

    fn ledgers(&mut self, out: &mut Assembly) {
        let inst = self.inst();
        let settings = &self.spec.settings;
        let fields: Vec<&String> = match &settings.ledger {
            None | Some(Ledger::All(true)) => self.module.surface.ledgers.iter().collect(),
            Some(Ledger::All(false)) => Vec::new(),
            Some(Ledger::Some(list)) => self
                .module
                .surface
                .ledgers
                .iter()
                .filter(|field| list.contains(field))
                .collect(),
        };
        let plain = settings.ledger_names == Some(LedgerNames::Plain) && !self.spec.merged;
        for field in fields {
            if plain {
                out.plain_ledgers.push(field.clone());
                out.ledger_exports.push(field.clone());
                out.taken.push((
                    field.clone(),
                    format!("ledger field {field}"),
                    format!("ledger {field}"),
                ));
            } else {
                let name = format!("{}{field}", inst.prefix);
                out.taken.push((
                    name.clone(),
                    format!("ledger field {name}"),
                    format!("ledger {name}"),
                ));
                out.ledger_exports.push(name);
                self.needs.prefixes.insert(self.current);
            }
        }
    }

    /// Per parameter of `circuit` (declared in `file`): the expression the mock passes
    /// instead, if any, and whether a caller is among them. A parameter is injected when
    /// its type and its name both match. `constructor` is set for the init circuit the
    /// constructor calls.
    fn injections(
        &mut self,
        file: FileId,
        circuit: &Circuit,
        constructor: bool,
    ) -> Result<(Vec<Option<String>>, bool), Error> {
        let mut inject: Vec<Option<String>> = vec![None; circuit.params.len()];
        let mut caller_injected = false;
        if let (Some(auth), Some(caller)) = (self.auth, self.caller) {
            let mut count = 0;
            for (position, param) in circuit.params.iter().enumerate() {
                match self
                    .files
                    .caller_match(file, &circuit.generics, &param.ty, caller)?
                {
                    CallerMatch::Exact
                        if param
                            .name()
                            .is_some_and(|name| auth.params.iter().any(|p| p == name)) =>
                    {
                        count += 1;
                        caller_injected = true;
                        if let Some(expr) = self.auth_expr() {
                            inject[position] = Some(expr);
                        }
                    }
                    CallerMatch::Contains if constructor => {
                        self.report(PlanError::ContainsCallerInitialize {
                            mock: self.mock(),
                            circuit: circuit.name.clone(),
                            param: param_label(param.name(), position),
                            contains: format!("{}, which contains {}", param.ty, caller.1),
                        });
                    }
                    CallerMatch::Contains => self.report(PlanError::ContainsCaller {
                        mock: self.mock(),
                        param: param_label(param.name(), position),
                        circuit: circuit.name.clone(),
                        ty: param.ty.clone(),
                        caller: caller.1.clone(),
                    }),
                    // Expansion already reported an unresolved type. A caller-typed
                    // parameter under another name stays a circuit argument.
                    CallerMatch::Exact | CallerMatch::Unresolved | CallerMatch::No => {}
                }
            }
            if count > 1 {
                self.report(PlanError::CallerTwice {
                    mock: self.mock(),
                    circuit: circuit.name.clone(),
                    count,
                    caller: caller.1.clone(),
                    constructor,
                });
            }
            if count > 0 {
                self.used_auth = true;
            }
        }
        let injected = inject.iter().any(Option::is_some);
        for (index, injector) in self.injectors.clone().into_iter().enumerate() {
            if injector.scope == InjectScope::Caller && !injected {
                continue;
            }
            for (position, param) in circuit.params.iter().enumerate() {
                if inject[position].is_some()
                    || !param
                        .name()
                        .is_some_and(|name| injector.params.iter().any(|p| p == name))
                {
                    continue;
                }
                let matched =
                    self.files
                        .caller_match(file, &circuit.generics, &param.ty, &injector.ty)?;
                if matched == CallerMatch::Exact {
                    inject[position] = Some(format!("{}{}", injector.prefix, injector.call));
                    self.used_injectors.insert(index);
                }
            }
        }
        Ok((inject, caller_injected))
    }

    /// The authenticator call for the current instance, with its salt slot filled. Salt
    /// errors are reported once per instance.
    fn auth_expr(&mut self) -> Option<String> {
        match &self.auth_exprs[self.current] {
            AuthExpr::Ready(expr) => return Some(expr.clone()),
            AuthExpr::Failed => return None,
            AuthExpr::Pending => {}
        }
        let expr = self.compute_auth_expr();
        self.auth_exprs[self.current] = expr.clone().map_or(AuthExpr::Failed, AuthExpr::Ready);
        expr
    }

    fn compute_auth_expr(&mut self) -> Option<String> {
        let auth = self.auth?;
        let inst = self.inst();
        let filled = match &auth.slot {
            None => auth.call.clone(),
            Some(slot) => match inst.salt.clone() {
                Some(Salt::Ledger(field)) => {
                    if !self.module.surface.ledgers.contains(&field) {
                        self.report(PlanError::SaltLedger {
                            mock: self.mock(),
                            field,
                            module: self.module.module.clone(),
                        });
                        return None;
                    }
                    self.needs.prefixes.insert(self.current);
                    slot.fill_expr(&auth.call, &format!("{}{field}", inst.prefix))
                }
                Some(Salt::Expr(expr)) => slot.fill_expr(&auth.call, &expr),
                text => {
                    let salt = match text {
                        Some(Salt::Text(salt)) => salt,
                        _ => self.spec.name.clone(),
                    };
                    let mut ok = true;
                    if !salt_characters_ok(&salt) {
                        self.report(PlanError::SaltChars { mock: self.mock() });
                        ok = false;
                    }
                    if let Some(width) = slot.width
                        && salt.len() > width
                    {
                        self.report(PlanError::SaltLength {
                            mock: self.mock(),
                            bytes: salt.len(),
                            salt,
                            width,
                        });
                        return None;
                    }
                    if !ok {
                        return None;
                    }
                    slot.fill_text(&auth.call, &salt)
                }
            },
        };
        Some(format!("{}{filled}", auth.prefix))
    }

    /// A circuit argument that is or holds the caller type would let the mock take a
    /// caller it never authenticates.
    fn check_caller_args(
        &mut self,
        file: FileId,
        circuit: &str,
        args: &[String],
        constructor: bool,
    ) -> Result<(), Error> {
        let Some(caller) = self.caller else {
            return Ok(());
        };
        for arg in args {
            let matched = self.files.caller_match(file, &[], arg, caller)?;
            if matches!(matched, CallerMatch::Exact | CallerMatch::Contains) {
                self.report(PlanError::CallerArgument {
                    mock: self.mock(),
                    circuit: circuit.to_owned(),
                    arg: arg.clone(),
                    caller: caller.1.clone(),
                    constructor,
                });
            }
        }
        Ok(())
    }

    /// The wrapper's parameters, and the arguments it forwards in module order.
    fn forwarded(
        &mut self,
        scope: &TypeScope<'_>,
        circuit: &Circuit,
        inject: &[Option<String>],
    ) -> Result<(Vec<Param>, Vec<String>), Error> {
        let mut params = Vec::new();
        let mut args = Vec::new();
        for (position, param) in circuit.params.iter().enumerate() {
            if let Some(expr) = &inject[position] {
                args.push(expr.clone());
                continue;
            }
            let Some(name) = param.name() else {
                self.report(PlanError::Pattern {
                    mock: self.mock(),
                    index: position + 1,
                    circuit: circuit.name.clone(),
                });
                continue;
            };
            params.push(Param {
                name: name.to_owned(),
                ty: self.spell(scope, &param.ty)?,
            });
            args.push(name.to_owned());
        }
        Ok((params, args))
    }

    /// Rewrites type text for the mock's scope, recording the imports it needs.
    fn spell(&mut self, scope: &TypeScope<'_>, ty: &str) -> Result<String, Error> {
        let mut replacements: HashMap<String, Option<String>> = HashMap::new();
        let own = scope.file == self.module.file;
        for name in identifiers(ty).map(str::to_owned).collect::<Vec<_>>() {
            if replacements.contains_key(&name) {
                continue;
            }
            let resolved = self.files.resolve(scope.file, scope.generics, &name)?;
            let replacement = match &resolved {
                Resolved::CircuitGeneric(index) => scope.circuit_args.get(*index).cloned(),
                Resolved::ModuleGeneric(index) if own => {
                    self.inst().module_args.get(*index).cloned()
                }
                Resolved::ModuleGeneric(_) => {
                    self.hidden(scope.circuit, &name);
                    None
                }
                Resolved::Local(decl) if decl.kind.is_type() => {
                    let visible = if own {
                        decl.exported
                    } else {
                        // A type local to another file is nameable only when the module
                        // re-exports that very declaration.
                        matches!(
                            self.files.resolve(self.module.file, &[], &name)?.decl(),
                            Some(found) if found == decl && found.exported
                        )
                    };
                    if visible {
                        self.needs.prefixes.insert(self.current);
                    } else {
                        self.hidden(scope.circuit, &name);
                    }
                    Some(format!("{}{}", self.inst().prefix, decl.name))
                }
                Resolved::Selective {
                    import,
                    element,
                    lookup,
                } => {
                    self.require_found(lookup)?;
                    self.needs.touch(scope.file);
                    self.needs.elements.insert((scope.file, *import, *element));
                    None
                }
                Resolved::Prefixed { import, lookup } | Resolved::Unprefixed { import, lookup } => {
                    self.require_found(lookup)?;
                    self.needs.touch(scope.file);
                    self.needs.imports.insert((scope.file, *import));
                    None
                }
                _ => None,
            };
            replacements.insert(name, replacement);
        }
        Ok(rewrite(ty, |name| {
            replacements.get(name).cloned().flatten()
        }))
    }

    fn hidden(&mut self, circuit: &str, ty: &str) {
        self.report(PlanError::HiddenType {
            mock: self.mock(),
            circuit: circuit.to_owned(),
            ty: ty.to_owned(),
            module: self.module.module.clone(),
        });
    }

    fn require_found(&self, lookup: &Lookup) -> Result<(), Error> {
        match lookup {
            Lookup::Missing(missing) => Err(self.files.missing_error(missing).into()),
            _ => Ok(()),
        }
    }

    /// Collects the export-list types of a circuit's signature, minus the parameters the
    /// wrapper drops. `own` is set for a circuit the module itself declares.
    fn collect_signature(
        &mut self,
        scope: &TypeScope<'_>,
        circuit: &Circuit,
        dropped: &[bool],
        own: bool,
        types: &mut BTreeSet<String>,
    ) -> Result<(), Error> {
        for (position, param) in circuit.params.iter().enumerate() {
            if dropped.get(position).copied().unwrap_or(false) {
                continue;
            }
            self.collect_types(scope, &param.ty, own, types, 0)?;
        }
        self.collect_types(scope, &circuit.ret, own, types, 0)
    }

    /// Adds the exportable types `ty` names. `own` is the module's own scope, where
    /// structs and enums are nameable and generic arguments are substituted; another
    /// file contributes standard types only. Contract types are never exported.
    fn collect_types(
        &mut self,
        scope: &TypeScope<'_>,
        ty: &str,
        own: bool,
        types: &mut BTreeSet<String>,
        depth: usize,
    ) -> Result<(), Error> {
        if depth > MAX_DEPTH {
            return Ok(());
        }
        for name in identifiers(ty).map(str::to_owned).collect::<Vec<_>>() {
            let resolved = self.files.resolve(scope.file, scope.generics, &name)?;
            let substituted = match resolved {
                Resolved::CircuitGeneric(index) if own => scope.circuit_args.get(index).cloned(),
                Resolved::ModuleGeneric(index) if own => {
                    self.inst().module_args.get(index).cloned()
                }
                _ => None,
            };
            if let Some(argument) = substituted {
                types.extend(
                    identifiers(&argument)
                        .filter(|name| EXPORTABLE_STD.contains(name))
                        .map(str::to_owned),
                );
                continue;
            }
            if let Some(lookup) = resolved.lookup() {
                if own {
                    self.require_found(lookup)?;
                }
                if !matches!(lookup, Lookup::Found(_)) {
                    continue;
                }
            }
            match &resolved {
                Resolved::Std if EXPORTABLE_STD.contains(&name.as_str()) => {
                    types.insert(name);
                }
                Resolved::Local(decl)
                | Resolved::Selective {
                    lookup: Lookup::Found(decl),
                    ..
                }
                | Resolved::Prefixed {
                    lookup: Lookup::Found(decl),
                    ..
                }
                | Resolved::Unprefixed {
                    lookup: Lookup::Found(decl),
                    ..
                } => {
                    if let DeclKind::Alias { rhs, .. } = &decl.kind {
                        // A local alias expands in the module's own scope; any other
                        // file's alias contributes standard types only.
                        let local = matches!(resolved, Resolved::Local(_));
                        let alias = TypeScope {
                            file: decl.file,
                            generics: &[],
                            circuit_args: &[],
                            circuit: scope.circuit,
                        };
                        let rhs = rhs.clone();
                        self.collect_types(&alias, &rhs, own && local, types, depth + 1)?;
                    } else if own && matches!(decl.kind, DeclKind::Struct | DeclKind::Enum) {
                        match &resolved {
                            Resolved::Local(_) => {
                                // A struct the module keeps private has no name in the mock.
                                if decl.exported {
                                    self.needs.prefixes.insert(self.current);
                                    types.insert(format!("{}{}", self.inst().prefix, decl.name));
                                }
                            }
                            Resolved::Selective {
                                import, element, ..
                            } => {
                                self.needs.touch(scope.file);
                                self.needs.elements.insert((scope.file, *import, *element));
                                types.insert(name);
                            }
                            Resolved::Prefixed { import, .. }
                            | Resolved::Unprefixed { import, .. } => {
                                self.needs.touch(scope.file);
                                self.needs.imports.insert((scope.file, *import));
                                types.insert(name);
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Groups 3 and 4 of the import block.
    #[allow(clippy::too_many_lines, reason = "the groups fill in emission order")]
    fn imports(
        &mut self,
        module: &crate::source::Module,
        assembly: &Assembly,
    ) -> Result<(Vec<ImportLine>, Vec<ImportLine>), Error> {
        let artifacts = self.artifacts();
        let file = self.module.file;
        let mut named = Vec::new();
        let mut replicated_prefixed = Vec::new();
        let mut order = vec![file];
        order.extend(self.needs.order.iter().copied().filter(|id| *id != file));
        for from in order {
            let source = self.files.get(from);
            let Some(from_module) = source.module.as_ref() else {
                continue;
            };
            for (index, import) in from_module.imports.iter().enumerate() {
                let Some(target) = self.files.import_file(from, import) else {
                    continue;
                };
                let selected: Vec<String> = import
                    .selection
                    .iter()
                    .enumerate()
                    .filter(|(element, _)| self.needs.elements.contains(&(from, index, *element)))
                    .map(|(_, element)| element.spelled())
                    .collect();
                let whole_needed = self.needs.imports.contains(&(from, index));
                if selected.is_empty() && !whole_needed {
                    continue;
                }
                let path = import_path(&artifacts, &target);
                let args = match &import.generic_args {
                    Some(text) => {
                        let scope = TypeScope {
                            file: from,
                            generics: &[],
                            circuit_args: &[],
                            circuit: "an import",
                        };
                        self.spell(&scope, text)?
                    }
                    None => String::new(),
                };
                if !selected.is_empty() {
                    named.push(ImportLine::Selective {
                        names: selected,
                        path,
                        args,
                    });
                } else if let Some(prefix) = &import.prefix {
                    replicated_prefixed.push(ImportLine::Prefixed {
                        path,
                        args,
                        prefix: prefix.clone(),
                    });
                } else {
                    replicated_prefixed.push(ImportLine::Whole { path, args });
                }
            }
        }
        let _ = module;

        let module_path = import_path(&artifacts, &self.config.module_file(&self.module.module));
        if !self.spec.merged {
            let args = generic_args_text(&self.spec.instances[0].module_args);
            let mut listed = assembly.reexports.clone();
            listed.extend(assembly.plain_ledgers.iter().cloned());
            if !listed.is_empty() {
                named.push(ImportLine::Selective {
                    names: listed,
                    path: module_path.clone(),
                    args,
                });
            }
        }

        let mut prefixed = Vec::new();
        if self.used_auth
            && let Some(auth) = self.auth
        {
            prefixed.push(ImportLine::Prefixed {
                path: import_path(&artifacts, &auth.file),
                args: String::new(),
                prefix: auth.prefix.clone(),
            });
        }
        for (index, injector) in self.injectors.iter().enumerate() {
            if self.used_injectors.contains(&index) {
                prefixed.push(ImportLine::Prefixed {
                    path: import_path(&artifacts, &injector.file),
                    args: String::new(),
                    prefix: injector.prefix.clone(),
                });
            }
        }
        prefixed.extend(replicated_prefixed);
        for (index, inst) in self.spec.instances.iter().enumerate() {
            if self.spec.merged || self.needs.prefixes.contains(&index) {
                prefixed.push(ImportLine::Prefixed {
                    path: module_path.clone(),
                    args: generic_args_text(&inst.module_args),
                    prefix: inst.prefix.clone(),
                });
            }
        }

        let mut seen: Vec<ImportLine> = Vec::new();
        let mut by_prefix: BTreeMap<String, String> = BTreeMap::new();
        for line in prefixed {
            if seen.contains(&line) {
                continue;
            }
            if let ImportLine::Prefixed { path, args, prefix } = &line {
                let spelled = format!("\"{path}\"{args}");
                if let Some(first) = by_prefix.get(prefix) {
                    self.report(PlanError::PrefixCollision {
                        mock: self.mock(),
                        prefix: prefix.clone(),
                        first: first.clone(),
                        second: spelled,
                    });
                } else {
                    by_prefix.insert(prefix.clone(), spelled);
                }
            }
            seen.push(line);
        }
        let mut named_seen: Vec<ImportLine> = Vec::new();
        for line in named {
            if !named_seen.contains(&line) {
                named_seen.push(line);
            }
        }
        Ok((named_seen, seen))
    }

    /// Group 2 and the `contract implements` lines, after checking every interface
    /// circuit is exposed.
    fn implements(
        &mut self,
        assembly: &Assembly,
        fragment_exports: &[String],
    ) -> Result<(Vec<ImportLine>, Vec<String>), Error> {
        let mut imports = Vec::new();
        let mut lines = Vec::new();
        let artifacts = self.artifacts();
        let exposed: BTreeSet<&str> = assembly
            .wrappers
            .iter()
            .map(|wrapper| wrapper.name.as_str())
            .chain(assembly.reexports.iter().map(String::as_str))
            .chain(fragment_exports.iter().map(String::as_str))
            .collect();
        for entry in self.spec.settings.implements.clone().unwrap_or_default() {
            let file = self.config.module_file(&entry.module);
            let id = self.files.require(&file)?;
            let source = self.files.get(id);
            let contract = source.module.as_ref().and_then(|module| {
                module.items.iter().find_map(|item| match item {
                    Item::Contract(contract)
                        if contract.name == entry.name && contract.exported =>
                    {
                        Some(contract.clone())
                    }
                    _ => None,
                })
            });
            let Some(contract) = contract else {
                self.report(PlanError::ImplementsNoContract {
                    mock: self.mock(),
                    interface: entry.name.clone(),
                    module: entry.module.clone(),
                });
                continue;
            };
            for circuit in &contract.circuits {
                if !exposed.contains(circuit.name.as_str()) {
                    let fragment = self.fragment_path();
                    self.report(PlanError::ImplementsMissing {
                        mock: self.mock(),
                        interface: entry.name.clone(),
                        circuit: circuit.name.clone(),
                        fragment: self.files.paths().show(&fragment),
                    });
                    continue;
                }
                let (Some(expected), Some(signature)) =
                    (&circuit.params, assembly.signatures.get(&circuit.name))
                else {
                    continue;
                };
                let differs = expected.len() != signature.types.len()
                    || (!signature.generic
                        && expected.iter().zip(&signature.types).any(|(want, have)| {
                            collapse(want) != collapse(have)
                                && self.canonical(id, want) != self.canonical(signature.file, have)
                        }));
                if differs {
                    self.report(PlanError::ImplementsSignature {
                        mock: self.mock(),
                        circuit: circuit.name.clone(),
                        params: format!(
                            "{}) where {} declares ({}",
                            signature.shown.join(", "),
                            entry.name,
                            expected.join(", ")
                        ),
                        interface: entry.name.clone(),
                    });
                }
            }
            imports.push(ImportLine::Selective {
                names: vec![entry.name.clone()],
                path: import_path(&artifacts, &file),
                args: String::new(),
            });
            lines.push(entry.name.clone());
        }
        Ok((imports, lines))
    }

    /// `ty` with every name that resolves in `file` replaced by its declaration, so two
    /// spellings of one type compare equal.
    fn canonical(&mut self, file: FileId, ty: &str) -> String {
        let files = &mut *self.files;
        rewrite(ty, |name| {
            files.resolve(file, &[], name).ok().and_then(|resolved| {
                resolved
                    .decl()
                    .map(|decl| format!("{}#{}", decl.file, decl.name))
            })
        })
    }

    /// Two witness declarations with one name, from two files the mock imports or
    /// includes.
    fn check_witnesses(
        &mut self,
        interfaces: &[ImportLine],
        named: &[ImportLine],
        prefixed: &[ImportLine],
        fragment: Option<&Path>,
    ) {
        let artifacts = self.artifacts();
        let mut roots: Vec<PathBuf> = interfaces
            .iter()
            .chain(named)
            .chain(prefixed)
            .map(|line| match line {
                ImportLine::Selective { path, .. }
                | ImportLine::Prefixed { path, .. }
                | ImportLine::Whole { path, .. } => {
                    normalize(&artifacts.join(format!("{path}.compact")))
                }
            })
            .collect();
        roots.extend(fragment.map(Path::to_owned));
        let found = self.files.witnesses(&roots);
        let mut first: BTreeMap<&str, FileId> = BTreeMap::new();
        let mut reported: BTreeSet<&str> = BTreeSet::new();
        let mut clashes = Vec::new();
        for (file, name) in &found {
            match first.get(name.as_str()) {
                Some(known) if known != file && reported.insert(name) => {
                    clashes.push((name.clone(), *known, *file));
                }
                Some(_) => {}
                None => {
                    first.insert(name, *file);
                }
            }
        }
        for (witness, left, right) in clashes {
            let first = self.files.paths().show(&self.files.path(left));
            let second = self.files.paths().show(&self.files.path(right));
            self.report(PlanError::WitnessClash {
                mock: self.mock(),
                witness,
                first,
                second,
            });
        }
    }

    /// No two names the mock declares or imports are equal. A clash is reported against
    /// the entry that is not the renamed wrapper.
    fn check_clashes(&mut self, assembly: &Assembly, named: &[ImportLine]) {
        let renamed = &assembly.renamed;
        let mut taken: Vec<(String, String, String)> = assembly.taken.clone();
        for ty in &assembly.types {
            taken.push((ty.clone(), format!("type {ty}"), format!("type {ty}")));
        }
        for line in named {
            if let ImportLine::Selective { names, .. } = line {
                for spelled in names {
                    let local = spelled.rsplit(" as ").next().unwrap_or(spelled);
                    // A name imported to be re-exported or exported as a type is the
                    // same entity; a wrapper renamed onto it is not.
                    let same = taken
                        .iter()
                        .any(|(name, _, identity)| name == local && !renamed.contains(identity));
                    if !same {
                        taken.push((
                            local.to_owned(),
                            format!("import {local}"),
                            format!("import {local}"),
                        ));
                    }
                }
            }
        }
        let mut order: Vec<&str> = Vec::new();
        let mut groups: HashMap<&str, Vec<&(String, String, String)>> = HashMap::new();
        for entry in &taken {
            let group = groups.entry(entry.0.as_str()).or_default();
            if group.is_empty() {
                order.push(&entry.0);
            }
            group.push(entry);
        }
        let mut clashes = Vec::new();
        for name in order {
            let group = &groups[name];
            let Some(last) = group.last() else {
                continue;
            };
            let target = group
                .iter()
                .find(|entry| renamed.contains(&entry.2))
                .unwrap_or(last);
            if let Some(existing) = group.iter().find(|entry| entry.2 != target.2) {
                clashes.push((name.to_owned(), existing.1.clone()));
            }
        }
        for (target, existing) in clashes {
            self.report(PlanError::RenameClash {
                mock: self.mock(),
                target,
                existing,
            });
        }
    }

    /// The conventional fragment path, `<test_dir>/<name>.fragment.compact`.
    fn fragment_path(&self) -> PathBuf {
        let test_dir = self.config.test_dir(&self.module.module);
        match &self.spec.settings.include {
            Some(Include::File(file)) => normalize(&test_dir.join(file)),
            _ => test_dir.join(format!("{}{FRAGMENT_SUFFIX}", self.spec.name)),
        }
    }

    /// The `include` line, the fragment's exported circuits, and whether it declares a
    /// constructor.
    fn include(&mut self) -> Result<(Option<String>, Vec<String>, bool), Error> {
        let path = self.fragment_path();
        match &self.spec.settings.include {
            Some(Include::Default(false)) => return Ok((None, Vec::new(), false)),
            Some(Include::File(_)) => {
                if !path.is_file() {
                    self.report(PlanError::FragmentMissing {
                        mock: self.mock(),
                        path: self.files.paths().show(&path),
                    });
                    return Ok((None, Vec::new(), false));
                }
            }
            _ => {
                if !path.is_file() {
                    return Ok((None, Vec::new(), false));
                }
            }
        }
        let id = self.files.require(&path)?;
        let fragment = self.files.get(id);
        let spelled = import_path(&self.artifacts(), &path);
        let without = spelled
            .strip_suffix(".fragment.compact")
            .map_or_else(|| spelled.clone(), |stem| format!("{stem}.fragment"));
        Ok((
            Some(without),
            fragment.exported_circuits.clone(),
            fragment.has_constructor,
        ))
    }
}

/// Group 3 minus the names group 2 already imports from the same path.
fn without_interfaces(named: Vec<ImportLine>, interfaces: &[ImportLine]) -> Vec<ImportLine> {
    named
        .into_iter()
        .filter_map(|line| match line {
            ImportLine::Selective { names, path, args } => {
                let kept: Vec<String> = names
                    .into_iter()
                    .filter(|name| {
                        !interfaces.iter().any(|interface| {
                            matches!(interface, ImportLine::Selective { names: taken, path: at, args: none }
                                if *at == path && none.is_empty() && args.is_empty() && taken.contains(name))
                        })
                    })
                    .collect();
                (!kept.is_empty()).then_some(ImportLine::Selective {
                    names: kept,
                    path,
                    args,
                })
            }
            other => Some(other),
        })
        .collect()
}

/// A module argument as compactc keys an instance: a numeric literal by its value, any
/// other argument by its text without whitespace.
fn argument_key(arg: &str) -> String {
    let text = arg.trim();
    let (digits, radix) = match text.get(..2) {
        Some("0x" | "0X") => (&text[2..], 16),
        Some("0o" | "0O") => (&text[2..], 8),
        Some("0b" | "0B") => (&text[2..], 2),
        _ => (text, 10),
    };
    match u128::from_str_radix(digits, radix) {
        Ok(value) if !digits.starts_with(['+', '-']) => value.to_string(),
        _ => text.chars().filter(|ch| !ch.is_whitespace()).collect(),
    }
}

/// Whether a return type is `[]`, however it is spaced.
fn returns_unit(ret: &str) -> bool {
    ret.split_whitespace().collect::<String>() == "[]"
}

/// `<#n, T>` as declared.
fn generics_text(generics: &[GenericParam]) -> String {
    let names: Vec<String> = generics
        .iter()
        .map(|param| {
            if param.numeric {
                format!("#{}", param.name)
            } else {
                param.name.clone()
            }
        })
        .collect();
    format!("<{}>", names.join(", "))
}

/// `<a, b>`, or nothing for no arguments.
fn generic_args_text(args: &[String]) -> String {
    if args.is_empty() {
        String::new()
    } else {
        format!("<{}>", args.join(", "))
    }
}

/// A salt lands inside a string literal byte for byte, so it must be non-empty and hold
/// nothing the literal would escape or end on.
fn salt_characters_ok(salt: &str) -> bool {
    !salt.is_empty()
        && !salt
            .chars()
            .any(|ch| matches!(ch, '"' | '\\' | '\u{0}'..='\u{1f}' | '\u{7f}'))
}

#[cfg(test)]
mod tests;
