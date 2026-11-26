//! What each mock contains: variants, exposed circuits, the action per circuit, imports,
//! the export list, the constructor and the include.
//!
//! Expansion and the config-wide checks run over every entry. Planning runs for the
//! selected mocks only. Every error is collected; nothing is planned when any occurs.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use crate::config::{
    Config, Entry, Guard, Include, Init, Settings, VariantKind, expand_out_dir, import_path,
    normalize,
};
use crate::error::{AuthError, ConfigError, Error, PlanError, SourceError};
use crate::params::{identifiers, is_name, rewrite};
use crate::scope::{CallerMatch, Decl, DeclKind, FileId, Files, Lookup, MAX_DEPTH, Resolved};
use crate::source::{Circuit, GenericParam, Item, SourceFile};

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

/// The module circuit a constructor calls.
const INITIALIZE: &str = "initialize";
const FRAGMENT_SUFFIX: &str = ".fragment.compact";
const GUARD_LEDGER: &str = "_invocations";
/// `pad(32, ...)` holds at most this many UTF-8 bytes.
const MAX_SALT_BYTES: usize = 32;

/// One planned mock, ready to render.
#[derive(Clone, Debug)]
pub struct MockPlan {
    pub name: String,
    /// Absolute path of the generated file.
    pub path: PathBuf,
    /// The `module` string as configured, for the header.
    pub module: String,
    pub spdx: Option<String>,
    pub pragma: String,
    /// The import block after `import CompactStandardLibrary;`, in emission order.
    pub imports: Vec<ImportLine>,
    /// Types, then re-exported circuits, then ledger fields.
    pub exports: Vec<String>,
    pub guard_ledger: bool,
    pub constructor: Option<Constructor>,
    pub wrappers: Vec<Wrapper>,
    /// The `include` path, without `.compact`.
    pub include: Option<String>,
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

#[derive(Clone, Debug)]
pub struct Constructor {
    pub params: Vec<Param>,
    pub flag: Option<String>,
    pub call: Call,
}

#[derive(Clone, Debug)]
pub struct Wrapper {
    pub name: String,
    pub pure: bool,
    pub params: Vec<Param>,
    pub ret: String,
    pub guard: bool,
    pub disclose: bool,
    pub call: Call,
}

/// The authenticated variant, the `*Caller` variant, or the only mock of an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Auth,
    Caller,
    Single,
}

/// One mock an entry expands to.
#[derive(Clone, Debug)]
struct Variant {
    entry: usize,
    kind: Kind,
    name: String,
    settings: Settings,
    /// Absolute output directory.
    out_dir: PathBuf,
    module_file: FileId,
    prefix: String,
}

impl Variant {
    fn path(&self) -> PathBuf {
        self.out_dir.join(format!("{}.compact", self.name))
    }
}

/// The resolved `[auth]` table.
struct AuthPlan {
    prefix: String,
    file: PathBuf,
    call: String,
    caller: (FileId, String),
}

/// What a run found before writing: errors no single mock owns, then each selected
/// mock in config order with its plan or its errors.
#[derive(Debug, Default)]
pub struct Outcome {
    /// `[auth]`, source, expansion, duplicate and name errors, in config order.
    pub errors: Vec<Error>,
    pub mocks: Vec<Result<MockPlan, Vec<Error>>>,
}

/// Expands every entry, checks the config-wide rules, then plans the mocks `names`
/// selects (all of them when empty), in config order.
///
/// An `[auth]` error stops the run, since every expansion depends on it. An entry that
/// fails to expand drops out, and the others are still planned so every error prints.
#[must_use]
pub fn plan(config: &Config, files: &mut Files, names: &[String]) -> Outcome {
    let mut outcome = Outcome::default();

    let auth = match &config.auth {
        Some(_) => match auth_plan(config, files) {
            Ok(auth) => Some(auth),
            Err(error) => {
                outcome.errors.push(error);
                return outcome;
            }
        },
        None => None,
    };

    let mut variants = Vec::new();
    let mut expanded_all = true;
    for (index, entry) in config.entries.iter().enumerate() {
        match expand(config, files, auth.as_ref(), index, entry) {
            Ok(mut expanded) => variants.append(&mut expanded),
            Err(mut found) => {
                expanded_all = false;
                outcome.errors.append(&mut found);
            }
        }
    }
    check_duplicates(config, files, &variants, &mut outcome.errors);

    // A name may belong to an entry that failed to expand, so it is unknown only when
    // every entry expanded.
    if expanded_all {
        for name in names {
            if !variants.iter().any(|variant| &variant.name == name) {
                outcome.errors.push(
                    ConfigError::UnknownName {
                        name: name.clone(),
                        cfg: config.shown.clone(),
                    }
                    .into(),
                );
            }
        }
    }

    for variant in &variants {
        if !names.is_empty() && !names.contains(&variant.name) {
            continue;
        }
        let mut planner = Planner {
            config,
            files: &mut *files,
            auth: auth.as_ref(),
            entry: &config.entries[variant.entry],
            variant,
            errors: Vec::new(),
            needs: Needs::default(),
        };
        let result = planner.plan();
        let mut errors = std::mem::take(&mut planner.errors);
        outcome.mocks.push(match result {
            Ok(plan) if errors.is_empty() => Ok(plan),
            Ok(_) => Err(errors),
            Err(error) => {
                errors.push(error);
                Err(errors)
            }
        });
    }
    outcome
}

fn module_file(config: &Config, module: &str) -> PathBuf {
    normalize(&config.src.join(format!("{module}.compact")))
}

fn auth_plan(config: &Config, files: &mut Files) -> Result<AuthPlan, Error> {
    let auth = config
        .auth
        .as_ref()
        .expect("auth_plan runs only with [auth] set");
    let file = module_file(config, &auth.module);
    let id = files.require(&file)?;
    let source = files.get(id);
    let module = single_module(&source, files)?;

    let head: String = auth
        .call
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '$')
        .collect();
    let exported = module.items.iter().any(
        |item| matches!(item, Item::Circuit(circuit) if circuit.exported && circuit.name == head),
    );
    if !exported {
        return Err(AuthError::Call {
            circuit: head,
            module: auth.module.clone(),
        }
        .into());
    }

    let caller_id = files.require(&module_file(config, &auth.caller_type.module))?;
    let caller_source = files.get(caller_id);
    let declares = caller_source.module.as_ref().is_some_and(|module| {
        module.items.iter().any(|item| {
            matches!(item, Item::Type(decl)
                if decl.name == auth.caller_type.name
                    && decl.kind == crate::source::TypeKind::Struct)
        })
    });
    if !declares {
        return Err(AuthError::CallerType {
            module: auth.caller_type.module.clone(),
            name: auth.caller_type.name.clone(),
        }
        .into());
    }

    Ok(AuthPlan {
        prefix: auth
            .prefix
            .clone()
            .unwrap_or_else(|| format!("{}_", module.name)),
        file,
        call: auth.call.clone(),
        caller: (caller_id, auth.caller_type.name.clone()),
    })
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
    Listed { name: String, decl: Decl },
}

impl Exposable {
    fn name(&self) -> &str {
        match self {
            Self::Own(circuit) => &circuit.name,
            Self::Listed { name, .. } => name,
        }
    }
}

/// The module's exported circuits and exported ledger fields, in module order.
struct Surface {
    circuits: Vec<Exposable>,
    ledgers: Vec<String>,
}

fn surface(files: &mut Files, file: FileId) -> Result<Surface, SourceError> {
    let source = files.get(file);
    let mut circuits: Vec<Exposable> = Vec::new();
    let mut ledgers: Vec<String> = Vec::new();
    let Some(module) = source.module.as_ref() else {
        return Ok(Surface { circuits, ledgers });
    };
    for item in &module.items {
        match item {
            Item::Circuit(circuit) if circuit.exported => {
                circuits.push(Exposable::Own(circuit.clone()));
            }
            Item::Ledger(ledger) if ledger.exported && !ledgers.contains(&ledger.name) => {
                ledgers.push(ledger.name.clone());
            }
            Item::ExportList(names) => {
                for name in names {
                    let resolved = files.resolve(file, &[], name)?;
                    if let Some(Lookup::Missing(missing)) = resolved.lookup() {
                        return Err(files.missing_error(missing));
                    }
                    let Some(decl) = resolved.decl() else {
                        continue;
                    };
                    match decl.kind {
                        DeclKind::Ledger if !ledgers.contains(name) => ledgers.push(name.clone()),
                        DeclKind::Circuit if circuits.iter().all(|known| known.name() != name) => {
                            if let Resolved::Local(_) = resolved {
                                if let Some(circuit) = files.circuit(decl) {
                                    circuits.push(Exposable::Own(circuit));
                                }
                            } else {
                                circuits.push(Exposable::Listed {
                                    name: name.clone(),
                                    decl: decl.clone(),
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
    Ok(Surface { circuits, ledgers })
}

/// Reads an entry's module and expands it into its variants.
fn expand(
    config: &Config,
    files: &mut Files,
    auth: Option<&AuthPlan>,
    index: usize,
    entry: &Entry,
) -> Result<Vec<Variant>, Vec<Error>> {
    let path = module_file(config, &entry.module);
    let id = files.require(&path).map_err(|error| vec![error.into()])?;
    let source = files.get(id);
    let module = single_module(&source, files).map_err(|error| vec![error.into()])?;
    if source.pragma.is_none() {
        return Err(vec![
            SourceError::NoPragma {
                path: files.paths().show(&path),
            }
            .into(),
        ]);
    }

    let mut errors: Vec<Error> = Vec::new();
    let base = entry
        .name
        .clone()
        .unwrap_or_else(|| format!("Mock{}", entry.stem()));
    if entry.name.is_none() && !is_name(&base) {
        errors.push(
            ConfigError::Identifier {
                cfg: config.shown.clone(),
                key: format!("{}: name", entry.module),
                value: base.clone(),
            }
            .into(),
        );
    }
    let prefix = entry
        .prefix
        .clone()
        .unwrap_or_else(|| format!("{}_", module.name));

    let has_caller = match auth {
        Some(auth) => {
            scan_callers(files, id, auth, &base, &mut errors).map_err(|error| vec![error.into()])?
        }
        None => false,
    };

    let kinds: Vec<Kind> = if has_caller {
        let allowed = entry
            .variants
            .clone()
            .unwrap_or_else(|| vec![VariantKind::Auth, VariantKind::Caller]);
        [Kind::Auth, Kind::Caller]
            .into_iter()
            .filter(|kind| match kind {
                Kind::Auth => allowed.contains(&VariantKind::Auth),
                _ => allowed.contains(&VariantKind::Caller),
            })
            .collect()
    } else {
        if let Some(auth) = auth {
            let present = [
                ("variants", entry.variants.is_some()),
                ("salt", entry.settings.salt.is_some()),
                ("[mock.auth]", entry.auth.is_some()),
                ("[mock.caller]", entry.caller.is_some()),
            ];
            for (key, _) in present.iter().filter(|(_, set)| *set) {
                errors.push(
                    PlanError::NoCallerParam {
                        mock: base.clone(),
                        module: entry.module.clone(),
                        caller: auth.caller.1.clone(),
                        key: (*key).to_owned(),
                    }
                    .into(),
                );
            }
        }
        vec![Kind::Single]
    };

    let mut variants = Vec::new();
    for kind in kinds {
        let shape = VariantShape {
            index,
            kind,
            base: &base,
            prefix: &prefix,
            module_file: id,
        };
        match variant(config, entry, &shape) {
            Ok(variant) => variants.push(variant),
            Err(mut found) => errors.append(&mut found),
        }
    }

    if errors.is_empty() {
        Ok(variants)
    } else {
        Err(errors)
    }
}

/// Whether any exported circuit takes the caller type. Parameter types that do not
/// resolve are reported against `base`.
fn scan_callers(
    files: &mut Files,
    id: FileId,
    auth: &AuthPlan,
    base: &str,
    errors: &mut Vec<Error>,
) -> Result<bool, SourceError> {
    let surface = surface(files, id)?;
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
            match files.caller_match(file, &circuit.generics, &param.ty, &auth.caller)? {
                CallerMatch::Exact | CallerMatch::Contains => has_caller = true,
                CallerMatch::Unresolved => errors.push(
                    PlanError::Unresolved {
                        mock: base.to_owned(),
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

/// What every variant of one entry shares.
struct VariantShape<'a> {
    index: usize,
    kind: Kind,
    base: &'a str,
    prefix: &'a str,
    module_file: FileId,
}

/// One variant's name, effective settings and output directory.
fn variant(
    config: &Config,
    entry: &Entry,
    shape: &VariantShape<'_>,
) -> Result<Variant, Vec<Error>> {
    let (name, settings) = match shape.kind {
        Kind::Auth => {
            let table = entry.auth.clone().unwrap_or_default();
            (
                table.name.clone().unwrap_or_else(|| shape.base.to_owned()),
                table.over(&entry.settings),
            )
        }
        Kind::Caller => {
            let table = entry.caller.clone().unwrap_or_default();
            (
                table
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}Caller", shape.base)),
                table.over(&entry.settings),
            )
        }
        Kind::Single => (shape.base.to_owned(), entry.settings.clone()),
    };
    let mut errors: Vec<Error> = Vec::new();
    let Ok(relative) = expand_out_dir(&entry.out_dir, &entry.module) else {
        return Err(vec![
            ConfigError::ParentAtRoot {
                cfg: config.shown.clone(),
                mock: name,
                module: entry.module.clone(),
            }
            .into(),
        ]);
    };
    if let Some(Include::File(file)) = &settings.include
        && !file.ends_with(FRAGMENT_SUFFIX)
    {
        errors.push(
            ConfigError::IncludeSuffix {
                cfg: config.shown.clone(),
                mock: name.clone(),
                value: file.clone(),
            }
            .into(),
        );
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(Variant {
        entry: shape.index,
        kind: shape.kind,
        name,
        settings,
        out_dir: normalize(&config.src.join(relative)),
        module_file: shape.module_file,
        prefix: shape.prefix.to_owned(),
    })
}

fn param_label(name: Option<&str>, position: usize) -> String {
    name.map_or_else(|| (position + 1).to_string(), str::to_owned)
}

/// Generated names and paths are unique, ignoring ASCII case.
fn check_duplicates(config: &Config, files: &Files, variants: &[Variant], errors: &mut Vec<Error>) {
    let mut names: HashMap<String, &str> = HashMap::new();
    let mut paths: HashMap<String, &str> = HashMap::new();
    for variant in variants {
        if names
            .insert(variant.name.to_ascii_lowercase(), &variant.name)
            .is_some()
        {
            errors.push(
                ConfigError::DuplicateName {
                    cfg: config.shown.clone(),
                    mock: variant.name.clone(),
                }
                .into(),
            );
            continue;
        }
        let shown = files.paths().show(&variant.path());
        if let Some(first) = paths.insert(shown.to_ascii_lowercase(), &variant.name) {
            errors.push(
                ConfigError::DuplicatePath {
                    cfg: config.shown.clone(),
                    mock: first.to_owned(),
                    other: variant.name.clone(),
                    path: shown,
                }
                .into(),
            );
        }
    }
}

/// Imports the emitted text depends on.
#[derive(Default)]
struct Needs {
    /// Selective elements, as (import, element) indices of the module's imports.
    elements: BTreeSet<(usize, usize)>,
    /// Prefixed and whole-module imports, by index.
    imports: BTreeSet<usize>,
    /// Some emitted text names `<prefix><name>`.
    module_prefix: bool,
}

/// The scope a type is written in.
struct TypeScope<'a> {
    file: FileId,
    generics: &'a [GenericParam],
    circuit_args: &'a [String],
    circuit: &'a str,
}

struct Planner<'a> {
    config: &'a Config,
    files: &'a mut Files,
    auth: Option<&'a AuthPlan>,
    entry: &'a Entry,
    variant: &'a Variant,
    errors: Vec<Error>,
    needs: Needs,
}

impl Planner<'_> {
    fn mock(&self) -> String {
        self.variant.name.clone()
    }

    fn report(&mut self, error: impl Into<Error>) {
        self.errors.push(error.into());
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one pass in rule order reads best as one function"
    )]
    fn plan(&mut self) -> Result<MockPlan, Error> {
        let file = self.variant.module_file;
        let source = self.files.get(file);
        let module = source.module.clone().expect("expansion checked the module");
        let settings = self.variant.settings.clone();
        let surface = surface(self.files, file)?;
        let names: Vec<&str> = surface.circuits.iter().map(Exposable::name).collect();

        if self.entry.module_args.len() != module.generics.len() {
            self.report(PlanError::ModuleArgsCount {
                mock: self.mock(),
                given: self.entry.module_args.len(),
                module: self.entry.module.clone(),
                takes: module.generics.len(),
            });
        }

        let exclude = settings.exclude.clone().unwrap_or_default();
        let disclose = settings.disclose.clone().unwrap_or_default();
        let guard_all = matches!(settings.guard, Some(Guard::All(true)));
        let guard_list = match &settings.guard {
            Some(Guard::Some(list)) => list.clone(),
            _ => Vec::new(),
        };
        let rename = settings.rename.clone().unwrap_or_default();
        let circuit_args = &self.entry.circuit_args;

        let keyed: [(&str, Vec<&String>); 5] = [
            ("exclude", exclude.iter().collect()),
            ("disclose", disclose.iter().collect()),
            ("guard", guard_list.iter().collect()),
            ("rename", rename.keys().collect()),
            ("circuit_args", circuit_args.keys().collect()),
        ];
        for (key, listed) in &keyed {
            for circuit in listed {
                if !names.contains(&circuit.as_str()) {
                    self.report(PlanError::UnknownCircuit {
                        mock: self.mock(),
                        key: (*key).to_owned(),
                        circuit: (*circuit).clone(),
                        module: self.entry.module.clone(),
                    });
                }
            }
        }

        let own_initialize = surface.circuits.iter().find_map(|circuit| match circuit {
            Exposable::Own(circuit) if circuit.name == INITIALIZE => Some(circuit.clone()),
            _ => None,
        });
        let init = settings
            .init
            .clone()
            .unwrap_or(if own_initialize.is_some() {
                Init::Plain
            } else {
                Init::None
            });
        if init != Init::None && own_initialize.is_none() {
            self.report(PlanError::NoInitialize {
                mock: self.mock(),
                init: init.to_string(),
                module: self.entry.module.clone(),
            });
        }

        let exposed: Vec<Exposable> = surface
            .circuits
            .iter()
            .filter(|circuit| !(circuit.name() == INITIALIZE && init != Init::None))
            .filter(|circuit| !exclude.iter().any(|name| name == circuit.name()))
            .cloned()
            .collect();
        let exposed_names: Vec<&str> = exposed.iter().map(Exposable::name).collect();
        for (key, listed) in &keyed[1..4] {
            for circuit in listed {
                if names.contains(&circuit.as_str()) && !exposed_names.contains(&circuit.as_str()) {
                    self.report(PlanError::NotExposed {
                        mock: self.mock(),
                        key: (*key).to_owned(),
                        circuit: (*circuit).clone(),
                    });
                }
            }
        }

        for (circuit, args) in circuit_args {
            let generics = surface.circuits.iter().find_map(|known| match known {
                Exposable::Own(own) if &own.name == circuit => Some(own.generics.len()),
                Exposable::Listed { name, .. } if name == circuit => Some(0),
                _ => None,
            });
            match generics {
                Some(0) => self.report(PlanError::CircuitArgsNotGeneric {
                    mock: self.mock(),
                    circuit: circuit.clone(),
                }),
                Some(takes) if takes != args.len() => self.report(PlanError::CircuitArgsCount {
                    mock: self.mock(),
                    circuit: circuit.clone(),
                    given: args.len(),
                    takes,
                }),
                _ => {}
            }
        }

        let mut types = BTreeSet::new();
        let mut reexports: Vec<String> = Vec::new();
        let mut wrappers: Vec<Wrapper> = Vec::new();
        let mut injected = false;
        for circuit in &exposed {
            let guarded = guard_all || guard_list.iter().any(|name| name == circuit.name());
            let disclosed = disclose.iter().any(|name| name == circuit.name());
            let renamed = rename.get(circuit.name()).cloned();
            match circuit {
                Exposable::Own(circuit) => {
                    let inject = self.injections(file, circuit)?;
                    let generic = !circuit.generics.is_empty();
                    if generic && !circuit_args.contains_key(&circuit.name) {
                        self.report(PlanError::GenericNoArgs {
                            mock: self.mock(),
                            circuit: circuit.name.clone(),
                            generics: generics_text(&circuit.generics),
                        });
                    }
                    if disclosed && returns_unit(&circuit.ret) {
                        self.report(PlanError::DiscloseUnit {
                            mock: self.mock(),
                            circuit: circuit.name.clone(),
                        });
                    }
                    let wraps = inject.contains(&true)
                        || generic
                        || disclosed
                        || guarded
                        || renamed.is_some();
                    if !wraps {
                        reexports.push(circuit.name.clone());
                        let scope = TypeScope {
                            file,
                            generics: &circuit.generics,
                            circuit_args: &[],
                            circuit: &circuit.name,
                        };
                        self.collect_signature(&scope, circuit, &[], &mut types)?;
                        continue;
                    }
                    injected |= inject.contains(&true);
                    let args = circuit_args.get(&circuit.name).cloned().unwrap_or_default();
                    let scope = TypeScope {
                        file,
                        generics: &circuit.generics,
                        circuit_args: &args,
                        circuit: &circuit.name,
                    };
                    let (params, call_args) = self.forwarded(&scope, circuit, &inject)?;
                    let ret = self.spell(&scope, &circuit.ret)?;
                    self.collect_signature(&scope, circuit, &inject, &mut types)?;
                    wrappers.push(Wrapper {
                        name: renamed.unwrap_or_else(|| circuit.name.clone()),
                        pure: circuit.pure && !inject.contains(&true) && !guarded,
                        params,
                        ret,
                        guard: guarded,
                        disclose: disclosed,
                        call: Call {
                            callee: format!(
                                "{}{}{}",
                                self.variant.prefix,
                                circuit.name,
                                generic_args_text(&args)
                            ),
                            args: call_args,
                        },
                    });
                }
                Exposable::Listed { name, decl } => {
                    let target = self.files.circuit(decl);
                    let mut wraps = disclosed || guarded || renamed.is_some();
                    if let Some(target) = &target {
                        wraps |= !target.generics.is_empty();
                        if self.variant.kind == Kind::Auth
                            && let Some(auth) = self.auth
                        {
                            for param in &target.params {
                                let matched = self.files.caller_match(
                                    decl.file,
                                    &target.generics,
                                    &param.ty,
                                    &auth.caller,
                                )?;
                                wraps |= matched != CallerMatch::No;
                            }
                        }
                    }
                    if wraps {
                        self.report(PlanError::ExportListWrapper {
                            mock: self.mock(),
                            circuit: name.clone(),
                            module: self.entry.module.clone(),
                        });
                        continue;
                    }
                    reexports.push(name.clone());
                    if let Some(target) = &target {
                        let scope = TypeScope {
                            file: decl.file,
                            generics: &target.generics,
                            circuit_args: &[],
                            circuit: name,
                        };
                        for text in target
                            .params
                            .iter()
                            .map(|param| &param.ty)
                            .chain([&target.ret])
                        {
                            self.collect_types(&scope, text, false, &mut types, 0)?;
                        }
                    }
                }
            }
        }

        let constructor = match (&init, &own_initialize) {
            (Init::Plain | Init::Flag(_), Some(initialize)) => {
                let inject = self.injections(file, initialize)?;
                injected |= inject.contains(&true);
                if !initialize.generics.is_empty() && !circuit_args.contains_key(INITIALIZE) {
                    self.report(PlanError::GenericNoArgs {
                        mock: self.mock(),
                        circuit: INITIALIZE.to_owned(),
                        generics: generics_text(&initialize.generics),
                    });
                }
                let args = circuit_args.get(INITIALIZE).cloned().unwrap_or_default();
                let scope = TypeScope {
                    file,
                    generics: &initialize.generics,
                    circuit_args: &args,
                    circuit: INITIALIZE,
                };
                let (params, call_args) = self.forwarded(&scope, initialize, &inject)?;
                self.collect_signature(&scope, initialize, &inject, &mut types)?;
                let flag = match &init {
                    Init::Flag(flag) => {
                        if params.iter().any(|param| &param.name == flag) {
                            self.report(PlanError::FlagClash {
                                mock: self.mock(),
                                flag: flag.clone(),
                            });
                        }
                        Some(flag.clone())
                    }
                    _ => None,
                };
                Some(Constructor {
                    params,
                    flag,
                    call: Call {
                        callee: format!(
                            "{}{INITIALIZE}{}",
                            self.variant.prefix,
                            generic_args_text(&args)
                        ),
                        args: call_args,
                    },
                })
            }
            _ => None,
        };

        let ledgers: Vec<String> = if settings.ledger.unwrap_or(true) {
            surface
                .ledgers
                .iter()
                .map(|ledger| format!("{}{ledger}", self.variant.prefix))
                .collect()
        } else {
            Vec::new()
        };
        let guard_ledger = wrappers.iter().any(|wrapper| wrapper.guard);

        if injected {
            self.check_salt();
        }

        let imports = self.imports(
            &module,
            file,
            &reexports,
            &wrappers,
            constructor.is_some(),
            &ledgers,
            injected,
        )?;

        self.check_renames(&exposed, &rename, &types, &ledgers, &imports, guard_ledger);

        let include = self.include(&init)?;

        let mut exports: Vec<String> = types.into_iter().collect();
        exports.extend(reexports);
        exports.extend(ledgers);

        Ok(MockPlan {
            name: self.variant.name.clone(),
            path: self.variant.path(),
            module: self.entry.module.clone(),
            spdx: self.config.spdx.clone(),
            pragma: source.pragma.clone().unwrap_or_default(),
            imports,
            exports,
            guard_ledger,
            constructor,
            wrappers,
            include,
        })
    }

    /// Per parameter of `circuit`: whether the authenticated variant injects it.
    fn injections(&mut self, file: FileId, circuit: &Circuit) -> Result<Vec<bool>, Error> {
        let mut inject = vec![false; circuit.params.len()];
        let (Kind::Auth, Some(auth)) = (self.variant.kind, self.auth) else {
            return Ok(inject);
        };
        for (position, param) in circuit.params.iter().enumerate() {
            match self
                .files
                .caller_match(file, &circuit.generics, &param.ty, &auth.caller)?
            {
                CallerMatch::Exact => inject[position] = true,
                CallerMatch::Contains => self.report(PlanError::ContainsCaller {
                    mock: self.mock(),
                    param: param_label(param.name(), position),
                    circuit: circuit.name.clone(),
                    ty: param.ty.clone(),
                    caller: auth.caller.1.clone(),
                }),
                // Expansion already reported it.
                CallerMatch::Unresolved | CallerMatch::No => {}
            }
        }
        Ok(inject)
    }

    /// The wrapper's parameters, and the arguments it forwards in module order.
    fn forwarded(
        &mut self,
        scope: &TypeScope<'_>,
        circuit: &Circuit,
        inject: &[bool],
    ) -> Result<(Vec<Param>, Vec<String>), Error> {
        let mut params = Vec::new();
        let mut args = Vec::new();
        for (position, param) in circuit.params.iter().enumerate() {
            if inject[position] {
                args.push(self.auth_call());
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

    fn salt(&self) -> String {
        self.variant
            .settings
            .salt
            .clone()
            .unwrap_or_else(|| self.variant.name.clone())
    }

    fn auth_call(&self) -> String {
        let auth = self.auth.expect("only the authenticated variant injects");
        format!(
            "{}{}",
            auth.prefix,
            auth.call.replacen("{salt}", &self.salt(), 1)
        )
    }

    fn check_salt(&mut self) {
        let salt = self.salt();
        if !salt_characters_ok(&salt) {
            self.report(PlanError::SaltChars { mock: self.mock() });
        }
        if salt.len() > MAX_SALT_BYTES {
            self.report(PlanError::SaltLength {
                mock: self.mock(),
                bytes: salt.len(),
                salt,
            });
        }
    }

    /// Rewrites type text for the mock's scope, recording the imports it needs.
    fn spell(&mut self, scope: &TypeScope<'_>, ty: &str) -> Result<String, Error> {
        let mut replacements: HashMap<String, Option<String>> = HashMap::new();
        for name in identifiers(ty).map(str::to_owned).collect::<Vec<_>>() {
            if replacements.contains_key(&name) {
                continue;
            }
            let resolved = self.files.resolve(scope.file, scope.generics, &name)?;
            let replacement = match &resolved {
                Resolved::CircuitGeneric(index) => scope.circuit_args.get(*index).cloned(),
                Resolved::ModuleGeneric(index) => self.entry.module_args.get(*index).cloned(),
                Resolved::Local(decl) if decl.kind.is_type() => {
                    if decl.exported {
                        self.needs.module_prefix = true;
                    } else {
                        self.report(PlanError::HiddenType {
                            mock: self.mock(),
                            circuit: scope.circuit.to_owned(),
                            ty: name.clone(),
                            module: self.entry.module.clone(),
                        });
                    }
                    Some(format!("{}{}", self.variant.prefix, decl.name))
                }
                Resolved::Selective {
                    import,
                    element,
                    lookup,
                } => {
                    self.require_found(lookup)?;
                    self.needs.elements.insert((*import, *element));
                    None
                }
                Resolved::Prefixed { import, lookup } | Resolved::Unprefixed { import, lookup } => {
                    self.require_found(lookup)?;
                    self.needs.imports.insert(*import);
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

    fn require_found(&self, lookup: &Lookup) -> Result<(), Error> {
        match lookup {
            Lookup::Missing(missing) => Err(self.files.missing_error(missing).into()),
            _ => Ok(()),
        }
    }

    /// Collects the export-list types of a module circuit's signature, minus the
    /// parameters the wrapper drops.
    fn collect_signature(
        &mut self,
        scope: &TypeScope<'_>,
        circuit: &Circuit,
        dropped: &[bool],
        types: &mut BTreeSet<String>,
    ) -> Result<(), Error> {
        for (position, param) in circuit.params.iter().enumerate() {
            if dropped.get(position).copied().unwrap_or(false) {
                continue;
            }
            self.collect_types(scope, &param.ty, true, types, 0)?;
        }
        self.collect_types(scope, &circuit.ret, true, types, 0)
    }

    /// Adds the exportable types `ty` names. `own` is the module's own scope, where
    /// structs and enums are nameable and generic arguments are substituted; another
    /// file contributes standard types only.
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
                Resolved::CircuitGeneric(index) if own => scope.circuit_args.get(index),
                Resolved::ModuleGeneric(index) if own => self.entry.module_args.get(index),
                _ => None,
            };
            if let Some(argument) = substituted {
                types.extend(
                    identifiers(argument)
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
                                    self.needs.module_prefix = true;
                                    types.insert(format!("{}{}", self.variant.prefix, decl.name));
                                }
                            }
                            Resolved::Selective {
                                import, element, ..
                            } => {
                                self.needs.elements.insert((*import, *element));
                                types.insert(name);
                            }
                            Resolved::Prefixed { import, .. }
                            | Resolved::Unprefixed { import, .. } => {
                                self.needs.imports.insert(*import);
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

    /// The import block: replicated module imports, the authenticator, then the module
    /// itself, selectively and under its prefix.
    #[allow(
        clippy::too_many_arguments,
        reason = "each input is one run of the import block"
    )]
    fn imports(
        &mut self,
        module: &crate::source::Module,
        file: FileId,
        reexports: &[String],
        wrappers: &[Wrapper],
        has_constructor: bool,
        ledgers: &[String],
        injected: bool,
    ) -> Result<Vec<ImportLine>, Error> {
        let out_dir = self.variant.out_dir.clone();
        let mut lines = Vec::new();
        for (index, import) in module.imports.iter().enumerate() {
            let Some(target) = self.files.import_file(file, import) else {
                continue;
            };
            let names: Vec<String> = import
                .selection
                .iter()
                .enumerate()
                .filter(|(element, _)| self.needs.elements.contains(&(index, *element)))
                .map(|(_, element)| element.spelled())
                .collect();
            let whole_needed = self.needs.imports.contains(&index);
            if names.is_empty() && !whole_needed {
                continue;
            }
            let path = import_path(&out_dir, &target);
            let args = match &import.generic_args {
                Some(text) => {
                    let scope = TypeScope {
                        file,
                        generics: &[],
                        circuit_args: &[],
                        circuit: "an import",
                    };
                    self.spell(&scope, text)?
                }
                None => String::new(),
            };
            if !names.is_empty() {
                lines.push(ImportLine::Selective { names, path, args });
            } else if let Some(prefix) = &import.prefix {
                lines.push(ImportLine::Prefixed {
                    path,
                    args,
                    prefix: prefix.clone(),
                });
            } else {
                lines.push(ImportLine::Whole { path, args });
            }
        }

        if injected && let Some(auth) = self.auth {
            lines.push(ImportLine::Prefixed {
                path: import_path(&out_dir, &auth.file),
                args: String::new(),
                prefix: auth.prefix.clone(),
            });
        }

        let module_path = import_path(&out_dir, &module_file(self.config, &self.entry.module));
        let module_args = generic_args_text(&self.entry.module_args);
        if !reexports.is_empty() {
            lines.push(ImportLine::Selective {
                names: reexports.to_vec(),
                path: module_path.clone(),
                args: module_args.clone(),
            });
        }
        if !wrappers.is_empty()
            || has_constructor
            || !ledgers.is_empty()
            || self.needs.module_prefix
        {
            lines.push(ImportLine::Prefixed {
                path: module_path,
                args: module_args,
                prefix: self.variant.prefix.clone(),
            });
        }

        let mut seen: Vec<ImportLine> = Vec::new();
        let mut prefixes: BTreeMap<String, String> = BTreeMap::new();
        for line in lines {
            if seen.contains(&line) {
                continue;
            }
            if let ImportLine::Prefixed { path, args, prefix } = &line {
                let spelled = format!("\"{path}\"{args}");
                if let Some(first) = prefixes.get(prefix) {
                    self.report(PlanError::PrefixCollision {
                        mock: self.mock(),
                        prefix: prefix.clone(),
                        first: first.clone(),
                        second: spelled,
                    });
                } else {
                    prefixes.insert(prefix.clone(), spelled);
                }
            }
            seen.push(line);
        }
        Ok(seen)
    }

    /// A rename target must not clash with any other name the mock exports or declares.
    fn check_renames(
        &mut self,
        exposed: &[Exposable],
        rename: &BTreeMap<String, String>,
        types: &BTreeSet<String>,
        ledgers: &[String],
        imports: &[ImportLine],
        guard_ledger: bool,
    ) {
        let mut taken: Vec<(String, String, Option<&str>)> = Vec::new();
        for circuit in exposed {
            let name = rename
                .get(circuit.name())
                .cloned()
                .unwrap_or_else(|| circuit.name().to_owned());
            taken.push((
                name.clone(),
                format!("circuit {name}"),
                Some(circuit.name()),
            ));
        }
        for ty in types {
            taken.push((ty.clone(), format!("type {ty}"), None));
        }
        for ledger in ledgers {
            taken.push((ledger.clone(), format!("ledger field {ledger}"), None));
        }
        for line in imports {
            if let ImportLine::Selective { names, .. } = line {
                for spelled in names {
                    let local = spelled.rsplit(" as ").next().unwrap_or(spelled);
                    // Listed once beside a type export of the same name. A circuit entry
                    // does not count, so a rename onto an imported name still clashes.
                    if !taken
                        .iter()
                        .any(|(name, _, owner)| name == local && owner.is_none())
                    {
                        taken.push((local.to_owned(), format!("import {local}"), None));
                    }
                }
            }
        }
        if guard_ledger {
            taken.push((
                GUARD_LEDGER.to_owned(),
                format!("ledger {GUARD_LEDGER}"),
                None,
            ));
        }
        for (old, new) in rename {
            let clash = taken
                .iter()
                .find(|(name, _, owner)| name == new && *owner != Some(old.as_str()));
            if let Some((_, existing, _)) = clash {
                let existing = existing.clone();
                self.report(PlanError::RenameClash {
                    mock: self.mock(),
                    target: new.clone(),
                    existing,
                });
            }
        }
    }

    /// The `include` line, after checking the fragment exists and parses.
    fn include(&mut self, init: &Init) -> Result<Option<String>, Error> {
        let file = match &self.variant.settings.include {
            Some(Include::Default(true)) => format!("{}{FRAGMENT_SUFFIX}", self.variant.name),
            Some(Include::File(file)) if file.ends_with(FRAGMENT_SUFFIX) => file.clone(),
            _ => return Ok(None),
        };
        let path = normalize(&self.variant.out_dir.join(&file));
        let shown = self.files.paths().show(&path);
        if !path.is_file() {
            self.report(PlanError::FragmentMissing {
                mock: self.mock(),
                path: shown,
            });
            return Ok(None);
        }
        let id = self.files.require(&path)?;
        if self.files.get(id).has_constructor && *init != Init::None {
            self.report(PlanError::FragmentConstructor {
                mock: self.mock(),
                path: shown,
            });
        }
        let without = file.strip_suffix(".compact").unwrap_or(&file).to_owned();
        Ok(Some(without))
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
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::{
        Call, ImportLine, MAX_SALT_BYTES, MockPlan, Outcome, plan, returns_unit, salt_characters_ok,
    };
    use crate::config::{Paths, load};
    use crate::render::render;
    use crate::scope::Files;

    const AUTH: &str = "[auth]\nmodule = \"auth/Gate\"\ncall = 'authenticate(pad(32, \"{salt}\"))'\ncaller_type = { name = \"Badge\", module = \"who/Who\" }\n";

    const GATE_CALL: &str = "Gate_authenticate(pad(32, \"MockDoor\"))";

    fn case(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    /// Plans `config` over the sources of fixture case `name`. Paths print relative to it.
    fn planned(name: &str, config: &str, names: &[&str]) -> Outcome {
        let root = case(name);
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        let path = directory.path().join("compact-mock.toml");
        let src = root.join("src").display().to_string();
        std::fs::write(&path, format!("src = {src:?}\n{config}")).expect("the config is written");
        let paths = Paths { cwd: root };
        let config = load(&path, &paths).expect("the config loads");
        let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        plan(&config, &mut Files::new(paths), &names)
    }

    /// Every error of a run, in print order.
    fn errors(outcome: &Outcome) -> Vec<String> {
        let mut found: Vec<String> = outcome.errors.iter().map(ToString::to_string).collect();
        for mock in &outcome.mocks {
            if let Err(errors) = mock {
                found.extend(errors.iter().map(ToString::to_string));
            }
        }
        found
    }

    /// The plans of a run that must succeed, by mock name.
    fn plans(outcome: Outcome) -> BTreeMap<String, MockPlan> {
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        outcome
            .mocks
            .into_iter()
            .map(|mock| {
                let plan = mock.unwrap_or_else(|errors| panic!("{errors:?}"));
                (plan.name.clone(), plan)
            })
            .collect()
    }

    fn wrapper_names(plan: &MockPlan) -> Vec<&str> {
        plan.wrappers
            .iter()
            .map(|wrapper| wrapper.name.as_str())
            .collect()
    }

    /// Every import line of `plan` that names `path`.
    fn module_imports<'a>(plan: &'a MockPlan, path: &str) -> Vec<&'a ImportLine> {
        plan.imports
            .iter()
            .filter(|line| match line {
                ImportLine::Selective { path: at, .. }
                | ImportLine::Prefixed { path: at, .. }
                | ImportLine::Whole { path: at, .. } => at == path,
            })
            .collect()
    }

    #[test]
    fn each_transform_forces_a_wrapper_and_anything_else_is_re_exported() {
        let calc = plans(planned(
            "rules",
            "[[mock]]\nmodule = \"calc/Calc\"\ninit = \"none\"\ndisclose = [\"double\"]\nguard = [\"total\"]\nrename = { reset = \"clear\" }\n",
            &[],
        ));
        let calc = &calc["MockCalc"];
        assert_eq!(wrapper_names(calc), ["double", "total", "clear"]);
        assert_eq!(calc.exports, ["initialize", "Calc__total"]);

        let pick = plans(planned(
            "generics",
            "[[mock]]\nmodule = \"pick/Pick\"\nmodule_args = [\"Field\"]\ncircuit_args = { choose = [\"Field\"], keep = [\"1\"] }\n",
            &[],
        ));
        assert_eq!(wrapper_names(&pick["MockPick"]), ["choose", "keep"]);
        assert_eq!(pick["MockPick"].exports, ["hold"]);

        let door = plans(planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Door\"\n"),
            &[],
        ));
        assert_eq!(
            wrapper_names(&door["MockDoor"]),
            ["open", "openFor", "knock"]
        );
        assert!(door["MockDoorCaller"].wrappers.is_empty());

        for plan in [
            calc,
            &pick["MockPick"],
            &door["MockDoor"],
            &door["MockDoorCaller"],
        ] {
            for line in &plan.imports {
                if let ImportLine::Selective { names, .. } = line {
                    for name in names {
                        assert!(!wrapper_names(plan).contains(&name.as_str()), "{name}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_wrapper_stays_pure_only_without_injection_or_guard() {
        let purity = |config: &str| {
            let plan = plans(planned("rules", config, &[]))
                .remove("MockCalc")
                .expect("planned");
            plan.wrappers
                .iter()
                .find(|wrapper| wrapper.call.callee == "Calc_double")
                .map(|wrapper| wrapper.pure)
        };
        let entry = "[[mock]]\nmodule = \"calc/Calc\"\n";
        assert_eq!(
            purity(&format!("{entry}disclose = [\"double\"]\n")),
            Some(true)
        );
        assert_eq!(
            purity(&format!("{entry}rename = {{ double = \"twice\" }}\n")),
            Some(true)
        );
        assert_eq!(
            purity(&format!("{entry}guard = [\"double\"]\n")),
            Some(false)
        );

        let mirror = plans(planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Mirror\"\ndisclose = [\"echo\"]\n"),
            &[],
        ));
        let pure: Vec<(&str, bool)> = mirror["MockMirror"]
            .wrappers
            .iter()
            .map(|wrapper| (wrapper.name.as_str(), wrapper.pure))
            .collect();
        assert_eq!(pure, [("reflect", false), ("echo", true)]);
        assert_eq!(wrapper_names(&mirror["MockMirrorCaller"]), ["echo"]);
    }

    #[test]
    fn initialize_leaves_the_surface_only_when_the_constructor_calls_it() {
        let calc = |init: &str| {
            plans(planned(
                "rules",
                &format!("[[mock]]\nmodule = \"calc/Calc\"\ninit = {init}\n"),
                &[],
            ))
            .remove("MockCalc")
            .expect("planned")
        };
        let none = calc("\"none\"");
        assert!(none.constructor.is_none());
        assert!(none.exports.contains(&"initialize".to_owned()));
        for init in ["\"plain\"", "{ flag = \"ready\" }"] {
            let plan = calc(init);
            let constructor = plan.constructor.as_ref().expect("a constructor");
            assert_eq!(constructor.call.callee, "Calc_initialize");
            assert_eq!(constructor.flag.is_some(), init.contains("flag"));
            assert!(!plan.exports.contains(&"initialize".to_owned()));
            assert!(!wrapper_names(&plan).contains(&"initialize"));
        }
    }

    #[test]
    fn a_circuit_the_module_keeps_private_is_never_exposed() {
        let plan = plans(planned(
            "rules",
            "[[mock]]\nmodule = \"calc/Calc\"\ninit = \"none\"\n",
            &[],
        ))
        .remove("MockCalc")
        .expect("planned");
        assert!(!plan.exports.contains(&"helper".to_owned()));
        assert_eq!(
            errors(&planned(
                "rules",
                "[[mock]]\nmodule = \"calc/Calc\"\nexclude = [\"helper\"]\n",
                &[]
            )),
            ["MockCalc: exclude names helper, which calc/Calc does not export as a circuit"]
        );
    }

    #[test]
    fn every_listing_key_names_an_exported_circuit() {
        let outcome = planned(
            "rules",
            "[[mock]]\nmodule = \"calc/Calc\"\nexclude = [\"a\"]\ndisclose = [\"b\"]\nguard = [\"c\"]\nrename = { d = \"e\" }\ncircuit_args = { f = [\"Field\"] }\n",
            &[],
        );
        assert_eq!(
            errors(&outcome),
            [
                ("exclude", "a"),
                ("disclose", "b"),
                ("guard", "c"),
                ("rename", "d"),
                ("circuit_args", "f"),
            ]
            .map(|(key, circuit)| format!(
                "MockCalc: {key} names {circuit}, which calc/Calc does not export as a circuit"
            ))
        );
    }

    #[test]
    fn a_selective_alias_is_replicated_and_exported_as_written() {
        let plan = plans(planned(
            "auth-layer",
            "[[mock]]\nmodule = \"door/Gatehouse\"\nguard = [\"log\"]\n",
            &[],
        ))
        .remove("MockGatehouse")
        .expect("planned");
        assert_eq!(
            plan.imports[0],
            ImportLine::Selective {
                names: vec!["Badge as Visitor".to_owned()],
                path: "../../../who/Who".to_owned(),
                args: String::new(),
            }
        );
        assert_eq!(plan.exports, ["Visitor", "greet"]);
        assert_eq!(plan.wrappers[0].params[0].ty, "Visitor");
    }

    #[test]
    fn disclose_or_guard_on_an_excluded_circuit_is_an_error() {
        let outcome = planned(
            "rules",
            "[[mock]]\nmodule = \"calc/Calc\"\nexclude = [\"total\", \"double\"]\ndisclose = [\"total\"]\nguard = [\"double\"]\n",
            &[],
        );
        assert_eq!(
            errors(&outcome),
            [
                "MockCalc: disclose names total, which MockCalc does not expose",
                "MockCalc: guard names double, which MockCalc does not expose",
            ]
        );
    }

    #[test]
    fn only_allow_listed_standard_types_and_nameable_structs_are_exported() {
        let plan = plans(planned(
            "types",
            "[[mock]]\nmodule = \"curve/Curve\"\n",
            &[],
        ))
        .remove("MockCurve")
        .expect("planned");
        assert_eq!(
            plan.exports,
            [
                "Either",
                "Maybe",
                "MerkleTreeDigest",
                "Secp256k1EcdsaSignature",
                "ZswapCoinPublicKey",
                "mix",
            ]
        );
        assert_eq!(
            plan.imports,
            [ImportLine::Selective {
                names: vec!["mix".to_owned()],
                path: "../../Curve".to_owned(),
                args: String::new(),
            }]
        );
    }

    #[test]
    fn sealed_and_plain_exported_ledgers_follow_module_order() {
        let plan = plans(planned("types", "[[mock]]\nmodule = \"reg/Vault\"\n", &[]))
            .remove("MockVault")
            .expect("planned");
        assert_eq!(plan.exports, ["read", "Vault__key", "Vault__reads"]);
    }

    #[test]
    fn the_module_is_imported_once_under_one_path_and_argument_text() {
        let plan = plans(planned(
            "generics",
            "[[mock]]\nmodule = \"bag/Bag\"\nmodule_args = [\"2\", \"Bytes<32>\"]\ncircuit_args = { initialize = [\"3\"] }\n",
            &[],
        ))
        .remove("MockBag")
        .expect("planned");
        let spelled: Vec<(&str, &str)> = module_imports(&plan, "../../Bag")
            .into_iter()
            .map(|line| match line {
                ImportLine::Selective { path, args, .. }
                | ImportLine::Prefixed { path, args, .. }
                | ImportLine::Whole { path, args } => (path.as_str(), args.as_str()),
            })
            .collect();
        assert_eq!(spelled, [("../../Bag", "<2, Bytes<32>>"); 2]);
    }

    #[test]
    fn replicated_imports_name_types_only() {
        let plan = plans(planned(
            "types",
            "[[mock]]\nmodule = \"shape/Stamp\"\n",
            &[],
        ))
        .remove("MockStamp")
        .expect("planned");
        assert_eq!(
            module_imports(&plan, "../../../geo/Factory"),
            [&ImportLine::Selective {
                names: vec!["Pin".to_owned()],
                path: "../../../geo/Factory".to_owned(),
                args: String::new(),
            }]
        );
    }

    #[test]
    fn disclose_appears_only_around_listed_calls_and_the_flag() {
        let plan = plans(planned(
            "rules",
            "[[mock]]\nmodule = \"calc/Calc\"\ninit = { flag = \"ready\" }\ndisclose = [\"double\", \"total\"]\n",
            &[],
        ))
        .remove("MockCalc")
        .expect("planned");
        let text = render(&plan);
        assert_eq!(text.matches("disclose(").count(), 3);
        assert!(text.contains("if (disclose(ready)) {"));
    }

    #[test]
    fn injected_arguments_keep_their_position_and_share_one_expression() {
        let door = plans(planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Door\"\n"),
            &[],
        ))
        .remove("MockDoor")
        .expect("planned");
        let knock = door
            .wrappers
            .iter()
            .find(|wrapper| wrapper.name == "knock")
            .expect("knock");
        assert_eq!(
            knock.call,
            Call {
                callee: "Door_knock".to_owned(),
                args: vec!["times".to_owned(), GATE_CALL.to_owned(), "note".to_owned()],
            }
        );
        let constructor = door.constructor.expect("a constructor");
        assert_eq!(constructor.call.args, [GATE_CALL, "opener"]);
        let params: Vec<&str> = knock
            .params
            .iter()
            .map(|param| param.name.as_str())
            .collect();
        assert_eq!(params, ["times", "note"]);
    }

    #[test]
    fn caller_and_single_mocks_never_import_or_call_the_authenticator() {
        let door = plans(planned(
            "auth-layer",
            &format!(
                "{AUTH}[[mock]]\nmodule = \"door/Door\"\n\n[[mock]]\nmodule = \"door/Twin\"\n"
            ),
            &[],
        ));
        for name in ["MockDoorCaller", "MockTwin"] {
            let text = render(&door[name]);
            assert!(!text.contains("auth/Gate"), "{name}");
            assert!(!text.contains("Gate_authenticate("), "{name}");
        }

        let pass = "[auth]\nmodule = \"auth/Pass\"\ncall = 'authenticate(pad(32, \"{salt}\"))'\ncaller_type = { name = \"Ticket\", module = \"auth/Pass\" }\n\n[[mock]]\nmodule = \"door/Turnstile\"\n";
        let turnstile = plans(planned("auth-layer", pass, &[]));
        let prefixed = ImportLine::Prefixed {
            path: "../../../auth/Pass".to_owned(),
            args: String::new(),
            prefix: "Pass_".to_owned(),
        };
        let authenticated = &turnstile["MockTurnstile"];
        assert_eq!(
            authenticated
                .imports
                .iter()
                .filter(|line| **line == prefixed)
                .count(),
            1
        );
        assert!(render(authenticated).contains("Pass_authenticate(pad(32, \"MockTurnstile\"))"));
        let caller = &turnstile["MockTurnstileCaller"];
        assert!(caller.imports.contains(&prefixed));
        assert!(!render(caller).contains("Pass_authenticate("));
        assert_eq!(caller.exports, ["Pass_Receipt", "Ticket", "enter"]);
    }

    #[test]
    fn the_salt_is_the_authenticated_name_unless_a_salt_is_set() {
        let call = |table: &str| {
            let plans = plans(planned(
                "auth-layer",
                &format!("{AUTH}[[mock]]\nmodule = \"door/Hinge\"\n{table}"),
                &[],
            ));
            let authenticated = plans
                .values()
                .find(|plan| {
                    plan.constructor
                        .as_ref()
                        .is_some_and(|ctor| ctor.params.is_empty())
                })
                .expect("the authenticated mock");
            let names: Vec<&String> = plans.keys().collect();
            (
                format!("{names:?}"),
                authenticated.constructor.as_ref().expect("ctor").call.args[0].clone(),
            )
        };
        assert_eq!(
            call("auth.name = \"MockHingeAuth\"\n"),
            (
                "[\"MockHingeAuth\", \"MockHingeCaller\"]".to_owned(),
                "Gate_authenticate(pad(32, \"MockHingeAuth\"))".to_owned()
            )
        );
        assert_eq!(
            call("salt = \"one\"\n").1,
            "Gate_authenticate(pad(32, \"one\"))"
        );
        assert_eq!(
            call("salt = \"one\"\nauth.salt = \"two\"\n").1,
            "Gate_authenticate(pad(32, \"two\"))"
        );
    }

    #[test]
    fn a_flag_may_reuse_a_parameter_name_the_authenticated_variant_drops() {
        let outcome = planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Door\"\ninit = {{ flag = \"keeper\" }}\n"),
            &[],
        );
        assert_eq!(
            errors(&outcome),
            ["MockDoorCaller: init flag keeper clashes with an initialize parameter"]
        );
    }

    #[test]
    fn two_renames_may_swap_names() {
        let plan = plans(planned(
            "rules",
            "[[mock]]\nmodule = \"calc/Calc\"\nrename = { total = \"reset\", reset = \"total\" }\n",
            &[],
        ))
        .remove("MockCalc")
        .expect("planned");
        let pairs: Vec<(&str, &str)> = plan
            .wrappers
            .iter()
            .map(|wrapper| (wrapper.name.as_str(), wrapper.call.callee.as_str()))
            .collect();
        assert_eq!(pairs, [("reset", "Calc_total"), ("total", "Calc_reset")]);
    }

    #[test]
    fn include_true_names_one_fragment_per_variant() {
        let outcome = planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Hinge\"\ninclude = true\n"),
            &[],
        );
        assert_eq!(
            errors(&outcome),
            [
                "MockHinge: fragment src/door/test/mocks/MockHinge.fragment.compact does not exist",
                "MockHingeCaller: fragment src/door/test/mocks/MockHingeCaller.fragment.compact does not exist",
            ]
        );
    }

    #[test]
    fn an_unresolved_parameter_type_fails_even_when_its_circuit_is_excluded() {
        let outcome = planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Lost\"\nexclude = [\"enter\", \"wander\"]\n"),
            &[],
        );
        assert_eq!(errors(&outcome).len(), 2);
        assert!(
            errors(&outcome)
                .iter()
                .all(|error| error.contains("does not resolve"))
        );
    }

    #[test]
    fn an_export_list_circuit_taking_the_caller_needs_a_wrapper_when_authenticated() {
        let outcome = planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Porch\"\n"),
            &[],
        );
        assert_eq!(
            errors(&outcome),
            [
                "MockPorch: open is re-exported by door/Porch's export list and needs a wrapper; add it to exclude"
            ]
        );
        let caller = plans(planned(
            "auth-layer",
            &format!("{AUTH}[[mock]]\nmodule = \"door/Porch\"\nvariants = [\"caller\"]\n"),
            &[],
        ));
        assert_eq!(caller["MockPorchCaller"].exports, ["open", "wait"]);
    }

    #[test]
    fn planning_and_rendering_twice_gives_the_same_bytes() {
        let config = format!("{AUTH}[[mock]]\nmodule = \"door/Door\"\n");
        let first = plans(planned("auth-layer", &config, &[]));
        let second = plans(planned("auth-layer", &config, &[]));
        for (name, plan) in &first {
            assert_eq!(render(plan), render(&second[name]), "{name}");
            assert!(render(plan).ends_with("}\n") && !render(plan).ends_with("\n\n"));
        }
    }

    #[test]
    fn a_unit_return_type_is_recognized_however_it_is_spaced() {
        assert!(returns_unit("[]"));
        assert!(returns_unit("[ ]"));
        assert!(!returns_unit("Field"));
        assert!(!returns_unit("Vector<0, Field>"));
    }

    #[test]
    fn the_salt_limit_counts_utf8_bytes() {
        let fits = [
            "a".repeat(32),
            format!("{}é", "a".repeat(30)),
            format!("{}aaaa", "🙂".repeat(7)),
        ];
        for salt in &fits {
            assert!(salt.len() <= MAX_SALT_BYTES, "{salt}");
        }
        let over = format!("{}é", "a".repeat(31));
        assert_eq!(over.chars().count(), 32);
        assert!(over.len() > MAX_SALT_BYTES);
        assert!("MockConfidentialFungibleTokenRegister".len() > MAX_SALT_BYTES);
    }

    #[test]
    fn a_salt_rejects_empty_quotes_backslashes_and_controls() {
        assert!(salt_characters_ok("MockGate"));
        assert!(salt_characters_ok("e\u{301}"));
        for salt in ["", "a\"b", "a\\nb", "a\tb", "a\nb", "a\u{7f}"] {
            assert!(!salt_characters_ok(salt), "{salt:?}");
        }
    }
}
