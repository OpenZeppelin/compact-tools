//! Name resolution across files.
//!
//! Files are parsed on first use and cached by canonical path, so a name the plan never
//! asks about never opens its file. Lookups follow re-exports through selective imports
//! and through a module's `export { }`, up to a fixed depth.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::config::{Paths, normalize};
use crate::error::SourceError;
use crate::params::{collapse, identifiers};
use crate::source::{
    self, Circuit, GenericParam, Import, ImportTarget, Item, ParseFailure, SourceFile, TypeKind,
};

/// Re-export and alias chains longer than this resolve to nothing.
pub const MAX_DEPTH: usize = 8;

/// Built-in type names that never need an import.
const BUILTINS: [&str; 6] = ["Boolean", "Field", "Uint", "Bytes", "Vector", "Opaque"];

pub type FileId = usize;

/// A declaration found in some file's module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decl {
    pub file: FileId,
    pub name: String,
    pub exported: bool,
    pub kind: DeclKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeclKind {
    Struct,
    Enum,
    Alias {
        rhs: String,
        nominal: bool,
    },
    Circuit,
    Ledger,
    Witness,
    /// A `contract` declaration: a type that is never exported at the top level.
    Contract,
}

impl DeclKind {
    /// Struct, enum, alias or contract.
    #[must_use]
    pub const fn is_type(&self) -> bool {
        matches!(
            self,
            Self::Struct | Self::Enum | Self::Alias { .. } | Self::Contract
        )
    }
}

/// The outcome of looking a name up through an import.
#[derive(Clone, Debug)]
pub enum Lookup {
    Found(Decl),
    /// An import on the way names a file that does not exist.
    Missing(MissingImport),
    /// The target module declares no such name.
    NotFound,
    /// The chain is longer than [`MAX_DEPTH`].
    TooDeep,
}

#[derive(Clone, Debug)]
pub struct MissingImport {
    pub from: FileId,
    pub import: String,
    pub target: PathBuf,
}

/// What an identifier in a type or an export list names, innermost scope first.
#[derive(Clone, Debug)]
pub enum Resolved {
    CircuitGeneric(usize),
    ModuleGeneric(usize),
    Local(Decl),
    Selective {
        import: usize,
        element: usize,
        lookup: Lookup,
    },
    Prefixed {
        import: usize,
        lookup: Lookup,
    },
    Builtin,
    /// Through an `import "<path>";` with no selection and no prefix.
    Unprefixed {
        import: usize,
        lookup: Lookup,
    },
    Std,
}

impl Resolved {
    /// The declaration behind an imported or local name, when one was found.
    #[must_use]
    pub fn decl(&self) -> Option<&Decl> {
        match self {
            Self::Local(decl) => Some(decl),
            Self::Selective { lookup, .. }
            | Self::Prefixed { lookup, .. }
            | Self::Unprefixed { lookup, .. } => match lookup {
                Lookup::Found(decl) => Some(decl),
                _ => None,
            },
            _ => None,
        }
    }

    /// The import lookup, for imported names.
    #[must_use]
    pub const fn lookup(&self) -> Option<&Lookup> {
        match self {
            Self::Selective { lookup, .. }
            | Self::Prefixed { lookup, .. }
            | Self::Unprefixed { lookup, .. } => Some(lookup),
            _ => None,
        }
    }
}

/// How a parameter type relates to the configured caller type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerMatch {
    No,
    /// The type is the caller type, possibly through structural aliases.
    Exact,
    /// The caller type appears inside the type, or behind a nominal alias.
    Contains,
    /// A name in the type comes through an import that does not resolve.
    Unresolved,
}

/// Every file the run has parsed.
pub struct Files {
    paths: Paths,
    parsed: Vec<Rc<SourceFile>>,
    by_key: HashMap<PathBuf, FileId>,
}

impl Files {
    #[must_use]
    pub fn new(paths: Paths) -> Self {
        Self {
            paths,
            parsed: Vec::new(),
            by_key: HashMap::new(),
        }
    }

    #[must_use]
    pub const fn paths(&self) -> &Paths {
        &self.paths
    }

    /// # Panics
    /// Panics on an id this table did not hand out.
    #[must_use]
    pub fn get(&self, id: FileId) -> Rc<SourceFile> {
        Rc::clone(&self.parsed[id])
    }

    /// Parses `path`, or returns the cached parse. `None` when the file does not exist.
    /// # Errors
    /// Returns a read or parse error.
    pub fn load(&mut self, path: &Path) -> Result<Option<FileId>, SourceError> {
        if !path.exists() {
            return Ok(None);
        }
        self.load_existing(path).map(Some)
    }

    /// Parses a file that must exist.
    /// # Errors
    /// Returns a read error when it is missing or unreadable, or a parse error.
    pub fn require(&mut self, path: &Path) -> Result<FileId, SourceError> {
        self.load_existing(path)
    }

    fn load_existing(&mut self, path: &Path) -> Result<FileId, SourceError> {
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
        if let Some(&id) = self.by_key.get(&key) {
            return Ok(id);
        }
        let shown = self.paths.show(path);
        let text = std::fs::read_to_string(path).map_err(|source| SourceError::Read {
            path: shown.clone(),
            source,
        })?;
        let file = source::parse(path, &text).map_err(|failure| match failure {
            ParseFailure::At { line, column } => SourceError::Parse {
                path: shown.clone(),
                line,
                column,
            },
            ParseFailure::NoTree => SourceError::Parse {
                path: shown.clone(),
                line: 1,
                column: 1,
            },
        })?;
        let id = self.parsed.len();
        self.parsed.push(Rc::new(file));
        self.by_key.insert(key, id);
        Ok(id)
    }

    /// The file an import names, or `None` for a library import.
    #[must_use]
    pub fn import_file(&self, from: FileId, import: &Import) -> Option<PathBuf> {
        let ImportTarget::Path(path) = &import.target else {
            return None;
        };
        let directory = self.parsed[from].path.parent().map(Path::to_owned)?;
        Some(normalize(&directory.join(format!("{path}.compact"))))
    }

    /// The error for an import whose file does not exist.
    #[must_use]
    pub fn missing_error(&self, missing: &MissingImport) -> SourceError {
        SourceError::Import {
            path: self.paths.show(&self.parsed[missing.from].path),
            import: missing.import.clone(),
            target: self.paths.show(&missing.target),
        }
    }

    /// The circuit `decl` names, read from its file.
    #[must_use]
    pub fn circuit(&self, decl: &Decl) -> Option<Circuit> {
        self.parsed[decl.file]
            .module
            .as_ref()?
            .items
            .iter()
            .find_map(|item| match item {
                Item::Circuit(circuit) if circuit.name == decl.name => Some(circuit.clone()),
                _ => None,
            })
    }

    /// Resolves `name` as written in `file`'s module, with `generics` the enclosing
    /// circuit's type parameters.
    /// # Errors
    /// Returns a read or parse error of a file the lookup opened.
    pub fn resolve(
        &mut self,
        file: FileId,
        generics: &[GenericParam],
        name: &str,
    ) -> Result<Resolved, SourceError> {
        if let Some(index) = generics.iter().position(|param| param.name == name) {
            return Ok(Resolved::CircuitGeneric(index));
        }
        let source = self.get(file);
        let Some(module) = source.module.as_ref() else {
            return Ok(Resolved::Std);
        };
        if let Some(index) = module.generics.iter().position(|param| param.name == name) {
            return Ok(Resolved::ModuleGeneric(index));
        }
        if let Some(decl) = local(file, &module.items, name) {
            return Ok(Resolved::Local(decl));
        }
        self.imported(file, name, 0)
    }

    /// Resolves `name` through `file`'s imports: selective, then prefixed, then the
    /// builtins, then whole-module imports. `depth` counts the files already crossed.
    fn imported(
        &mut self,
        file: FileId,
        name: &str,
        depth: usize,
    ) -> Result<Resolved, SourceError> {
        let source = self.get(file);
        let Some(module) = source.module.as_ref() else {
            return Ok(Resolved::Std);
        };
        for (index, import) in module.imports.iter().enumerate() {
            if let Some(element) = import
                .selection
                .iter()
                .position(|element| element.local() == name)
            {
                let original = import.selection[element].name.clone();
                let lookup = self.through(file, import, &original, depth)?;
                return Ok(Resolved::Selective {
                    import: index,
                    element,
                    lookup,
                });
            }
        }

        let prefixed = module
            .imports
            .iter()
            .enumerate()
            .filter_map(|(index, import)| Some((index, import, import.prefix.as_deref()?)))
            .filter(|(_, _, prefix)| name.len() > prefix.len() && name.starts_with(prefix))
            .max_by_key(|(_, _, prefix)| prefix.len());
        if let Some((index, import, prefix)) = prefixed {
            let lookup = self.through(file, import, &name[prefix.len()..], depth)?;
            return Ok(Resolved::Prefixed {
                import: index,
                lookup,
            });
        }

        if BUILTINS.contains(&name) {
            return Ok(Resolved::Builtin);
        }

        // A missing file or a chain past the depth limit may hold the name, so either
        // outranks the standard-library fallback.
        let mut unresolved = None;
        for (index, import) in module.imports.iter().enumerate() {
            let whole = import.selection.is_empty()
                && import.prefix.is_none()
                && matches!(import.target, ImportTarget::Path(_));
            if !whole {
                continue;
            }
            match self.through(file, import, name, depth)? {
                Lookup::Found(decl) => {
                    return Ok(Resolved::Unprefixed {
                        import: index,
                        lookup: Lookup::Found(decl),
                    });
                }
                Lookup::NotFound => {}
                lookup => {
                    unresolved.get_or_insert((index, lookup));
                }
            }
        }
        if let Some((import, lookup)) = unresolved {
            return Ok(Resolved::Unprefixed { import, lookup });
        }
        Ok(Resolved::Std)
    }

    /// Looks `name` up in the file `import` names.
    fn through(
        &mut self,
        from: FileId,
        import: &Import,
        name: &str,
        depth: usize,
    ) -> Result<Lookup, SourceError> {
        let Some(target) = self.import_file(from, import) else {
            return Ok(Lookup::NotFound);
        };
        match self.load(&target)? {
            None => Ok(Lookup::Missing(MissingImport {
                from,
                import: match &import.target {
                    ImportTarget::Path(path) | ImportTarget::Library(path) => path.clone(),
                },
                target,
            })),
            Some(id) => self.find(id, name, depth + 1),
        }
    }

    /// Finds a declaration named `name` in `file`'s module. A name the module's
    /// `export { }` lists resolves in the module's own scope, through every import form;
    /// any other name follows selective imports only.
    fn find(&mut self, file: FileId, name: &str, depth: usize) -> Result<Lookup, SourceError> {
        if depth > MAX_DEPTH {
            return Ok(Lookup::TooDeep);
        }
        let source = self.get(file);
        let Some(module) = source.module.as_ref() else {
            return Ok(Lookup::NotFound);
        };
        if let Some(decl) = local(file, &module.items, name) {
            return Ok(Lookup::Found(decl));
        }
        if listed(&module.items, name) {
            return Ok(self
                .imported(file, name, depth)?
                .lookup()
                .cloned()
                .unwrap_or(Lookup::NotFound));
        }
        for import in &module.imports {
            if let Some(element) = import
                .selection
                .iter()
                .find(|element| element.local() == name)
            {
                return self.through(file, import, &element.name, depth);
            }
        }
        Ok(Lookup::NotFound)
    }

    /// The type parameters and field types of the struct `decl` names.
    fn struct_fields(&self, decl: &Decl) -> Option<(Vec<GenericParam>, Vec<String>)> {
        self.parsed[decl.file]
            .module
            .as_ref()?
            .items
            .iter()
            .find_map(|item| match item {
                Item::Type(ty) if ty.name == decl.name && ty.kind == TypeKind::Struct => {
                    Some((ty.generics.clone(), ty.fields.clone()))
                }
                _ => None,
            })
    }

    /// How `ty`, written in `file` with circuit `generics`, relates to the declaration
    /// `caller` (file and name).
    /// # Errors
    /// Returns a read or parse error of a file the lookup opened.
    pub fn caller_match(
        &mut self,
        file: FileId,
        generics: &[GenericParam],
        ty: &str,
        caller: &(FileId, String),
    ) -> Result<CallerMatch, SourceError> {
        self.caller_match_at(file, generics, ty, caller, 0)
    }

    fn caller_match_at(
        &mut self,
        file: FileId,
        generics: &[GenericParam],
        ty: &str,
        caller: &(FileId, String),
        depth: usize,
    ) -> Result<CallerMatch, SourceError> {
        let names: Vec<String> = identifiers(ty).map(str::to_owned).collect();
        let single = names.len() == 1 && collapse(ty) == names[0];
        let mut contains = false;
        for name in &names {
            let resolved = self.resolve(file, generics, name)?;
            if let Some(lookup) = resolved.lookup()
                && !matches!(lookup, Lookup::Found(_))
            {
                return Ok(CallerMatch::Unresolved);
            }
            let Some(decl) = resolved.decl() else {
                continue;
            };
            if decl.file == caller.0 && decl.name == caller.1 {
                if single {
                    return Ok(CallerMatch::Exact);
                }
                contains = true;
                continue;
            }
            if !matches!(decl.kind, DeclKind::Alias { .. } | DeclKind::Struct) {
                continue;
            }
            if depth >= MAX_DEPTH {
                return Ok(CallerMatch::Unresolved);
            }
            if let DeclKind::Alias { rhs, nominal } = &decl.kind {
                match self.caller_match_at(decl.file, &[], rhs, caller, depth + 1)? {
                    CallerMatch::Exact if single && !nominal => return Ok(CallerMatch::Exact),
                    CallerMatch::Exact | CallerMatch::Contains => contains = true,
                    CallerMatch::Unresolved => return Ok(CallerMatch::Unresolved),
                    CallerMatch::No => {}
                }
                continue;
            }
            let Some((params, fields)) = self.struct_fields(decl) else {
                continue;
            };
            for field in &fields {
                match self.caller_match_at(decl.file, &params, field, caller, depth + 1)? {
                    CallerMatch::Exact | CallerMatch::Contains => contains = true,
                    CallerMatch::Unresolved => return Ok(CallerMatch::Unresolved),
                    CallerMatch::No => {}
                }
            }
        }
        Ok(if contains {
            CallerMatch::Contains
        } else {
            CallerMatch::No
        })
    }
}

impl Files {
    /// Every witness declared over the transitive import closure of `roots`, as
    /// (declaring file, name), in walk order. A root or import that does not resolve or
    /// does not parse is skipped.
    pub fn witnesses(&mut self, roots: &[PathBuf]) -> Vec<(FileId, String)> {
        let mut seen: Vec<FileId> = Vec::new();
        let mut pending: Vec<PathBuf> = roots.iter().rev().cloned().collect();
        let mut found = Vec::new();
        while let Some(path) = pending.pop() {
            let Ok(Some(id)) = self.load(&path) else {
                continue;
            };
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            let source = self.get(id);
            let Some(module) = source.module.as_ref() else {
                continue;
            };
            for item in &module.items {
                if let Item::Witness(witness) = item {
                    found.push((id, witness.name.clone()));
                }
            }
            let mut next: Vec<PathBuf> = module
                .imports
                .iter()
                .filter_map(|import| self.import_file(id, import))
                .collect();
            next.reverse();
            pending.extend(next);
        }
        found
    }

    /// The canonical path of a parsed file, for messages and identity.
    #[must_use]
    pub fn path(&self, id: FileId) -> PathBuf {
        self.parsed[id].path.clone()
    }
}

/// Whether an `export { }` among `items` names `name`.
fn listed(items: &[Item], name: &str) -> bool {
    items.iter().any(|item| match item {
        Item::ExportList(names) => names.iter().any(|listed| listed.name == name),
        _ => false,
    })
}

/// The declaration named `name` among `items`. It is exported when its own `export`
/// keyword or an `export { }` of the module says so.
fn local(file: FileId, items: &[Item], name: &str) -> Option<Decl> {
    let in_list = listed(items, name);
    items.iter().find_map(|item| {
        let (exported, kind) = match item {
            Item::Circuit(circuit) if circuit.name == name => (circuit.exported, DeclKind::Circuit),
            Item::Ledger(ledger) if ledger.name == name => (ledger.exported, DeclKind::Ledger),
            Item::Witness(witness) if witness.name == name => (witness.exported, DeclKind::Witness),
            Item::Contract(contract) if contract.name == name => {
                (contract.exported, DeclKind::Contract)
            }
            Item::Type(decl) if decl.name == name => (
                decl.exported,
                match &decl.kind {
                    TypeKind::Struct => DeclKind::Struct,
                    TypeKind::Enum => DeclKind::Enum,
                    TypeKind::Alias { rhs, nominal } => DeclKind::Alias {
                        rhs: rhs.clone(),
                        nominal: *nominal,
                    },
                },
            ),
            _ => return None,
        };
        Some(Decl {
            file,
            name: name.to_owned(),
            exported: exported || in_list,
            kind,
        })
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{CallerMatch, DeclKind, Files, Lookup, MAX_DEPTH, Resolved};
    use crate::config::Paths;
    use crate::source::GenericParam;

    /// Writes `files` under a temporary root and returns it with a fresh table.
    fn tree(files: &[(&str, &str)]) -> (tempfile::TempDir, Files) {
        let root = tempfile::TempDir::new().expect("a temporary directory");
        for (path, text) in files {
            let full = root.path().join(path);
            std::fs::create_dir_all(full.parent().expect("a parent")).expect("dirs");
            std::fs::write(full, text).expect("the file is written");
        }
        let files = Files::new(Paths {
            cwd: root.path().to_owned(),
        });
        (root, files)
    }

    fn load(files: &mut Files, root: &Path, path: &str) -> usize {
        files.require(&root.join(path)).expect("the file parses")
    }

    const ID: &str = "module Id {\n  export type Account = Either<Bytes<32>, ContractAddress>;\n  export struct Who { id: Account; }\n}\n";

    #[test]
    fn a_selective_alias_resolves_to_the_original_declaration() {
        let (root, mut files) = tree(&[
            ("id/Id.compact", ID),
            (
                "a/M.compact",
                "module M {\n  import { Who as Person } from \"../id/Id\";\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "a/M.compact");
        let resolved = files.resolve(module, &[], "Person").expect("resolves");
        let decl = resolved.decl().expect("found");
        assert_eq!(decl.name, "Who");
        assert_eq!(decl.kind, DeclKind::Struct);
        assert!(matches!(resolved, Resolved::Selective { element: 0, .. }));
    }

    #[test]
    fn the_longest_prefix_wins() {
        let (root, mut files) = tree(&[
            ("A.compact", "module A { export struct B_x { } }\n"),
            ("AB.compact", "module AB { export struct x { } }\n"),
            (
                "M.compact",
                "module M {\n  import \"./A\" prefix A_;\n  import \"./AB\" prefix A_B_;\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "M.compact");
        let resolved = files.resolve(module, &[], "A_B_x").expect("resolves");
        assert!(matches!(resolved, Resolved::Prefixed { import: 1, .. }));
    }

    #[test]
    fn an_unneeded_import_is_never_opened() {
        let (root, mut files) = tree(&[(
            "M.compact",
            "module M {\n  import \"./Gone\" prefix Gone_;\n}\n",
        )]);
        let module = load(&mut files, root.path(), "M.compact");
        let resolved = files.resolve(module, &[], "Either").expect("resolves");
        assert!(matches!(resolved, Resolved::Std));
        let resolved = files.resolve(module, &[], "Gone_Thing").expect("resolves");
        assert!(matches!(
            resolved,
            Resolved::Prefixed {
                lookup: Lookup::Missing(_),
                ..
            }
        ));
    }

    #[test]
    fn a_re_exported_ledger_resolves_through_the_export_chain() {
        let (root, mut files) = tree(&[
            (
                "Inner.compact",
                "module Inner<T> { export ledger _items: Set<T>; }\n",
            ),
            (
                "Outer.compact",
                "module Outer {\n  import { _items } from \"./Inner\"<Bytes<32>>;\n  export { _items };\n}\n",
            ),
            (
                "M.compact",
                "module M {\n  import { _items } from \"./Outer\";\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "M.compact");
        let resolved = files.resolve(module, &[], "_items").expect("resolves");
        assert_eq!(resolved.decl().expect("found").kind, DeclKind::Ledger);
    }

    #[test]
    fn a_cycle_terminates() {
        let (root, mut files) = tree(&[
            ("A.compact", "module A {\n  import { X } from \"./B\";\n}\n"),
            ("B.compact", "module B {\n  import { X } from \"./A\";\n}\n"),
        ]);
        let module = load(&mut files, root.path(), "A.compact");
        let resolved = files.resolve(module, &[], "X").expect("resolves");
        assert!(matches!(
            resolved,
            Resolved::Selective {
                lookup: Lookup::TooDeep,
                ..
            }
        ));
    }

    #[test]
    fn caller_matching_compares_declarations_not_text() {
        let (root, mut files) = tree(&[
            ("id/Id.compact", ID),
            (
                "a/M.compact",
                "module M {\n  import { Who } from \"../id/Id\";\n  import \"../id/Id\" prefix Id_;\n  struct Mine { }\n  type Alias = Who;\n  new type Tagged = Who;\n}\n",
            ),
            ("b/N.compact", "module N {\n  export struct Who { }\n}\n"),
        ]);
        let module = load(&mut files, root.path(), "a/M.compact");
        let id = load(&mut files, root.path(), "id/Id.compact");
        let caller = (id, "Who".to_owned());
        let other = load(&mut files, root.path(), "b/N.compact");

        let mut check = |file, ty: &str| files.caller_match(file, &[], ty, &caller).expect("ok");
        assert_eq!(check(module, "Who"), CallerMatch::Exact);
        assert_eq!(check(module, "Id_Who"), CallerMatch::Exact);
        assert_eq!(check(module, "Alias"), CallerMatch::Exact);
        assert_eq!(check(module, "Tagged"), CallerMatch::Contains);
        assert_eq!(check(module, "Maybe<Who>"), CallerMatch::Contains);
        assert_eq!(check(module, "Mine"), CallerMatch::No);
        assert_eq!(check(module, "Id_Account"), CallerMatch::No);
        assert_eq!(check(other, "Who"), CallerMatch::No);
    }

    #[test]
    fn a_caller_type_behind_a_missing_import_does_not_resolve() {
        let (root, mut files) = tree(&[(
            "M.compact",
            "module M {\n  import { Who } from \"./Gone\";\n  import \"./AlsoGone\";\n}\n",
        )]);
        let module = load(&mut files, root.path(), "M.compact");
        let caller = (module, "Nothing".to_owned());
        assert_eq!(
            files.caller_match(module, &[], "Who", &caller).expect("ok"),
            CallerMatch::Unresolved
        );
        assert_eq!(
            files
                .caller_match(module, &[], "Other", &caller)
                .expect("ok"),
            CallerMatch::Unresolved
        );
    }

    #[test]
    fn resolution_tries_the_innermost_scope_first() {
        let (root, mut files) = tree(&[
            ("L.compact", "module L { export struct Shared { } }\n"),
            (
                "M.compact",
                "module M<T> {\n  import { Shared as L_Shared } from \"./L\";\n  import \"./L\" prefix L_;\n  struct Maybe { }\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "M.compact");
        let circuit_t = [GenericParam {
            name: "T".to_owned(),
            numeric: false,
        }];
        let mut resolve = |generics: &[GenericParam], name: &str| {
            files.resolve(module, generics, name).expect("resolves")
        };
        assert!(matches!(
            resolve(&circuit_t, "T"),
            Resolved::CircuitGeneric(0)
        ));
        assert!(matches!(resolve(&[], "T"), Resolved::ModuleGeneric(0)));
        assert!(matches!(resolve(&[], "Maybe"), Resolved::Local(_)));
        assert!(matches!(
            resolve(&[], "L_Shared"),
            Resolved::Selective { .. }
        ));
        assert!(matches!(resolve(&[], "Field"), Resolved::Builtin));
        assert!(matches!(resolve(&[], "Either"), Resolved::Std));
    }

    #[test]
    fn an_unprefixed_whole_module_import_resolves_before_std() {
        let (root, mut files) = tree(&[
            ("Who.compact", "module Who { export struct Badge { } }\n"),
            (
                "M.compact",
                "module M {\n  import \"./Gone\";\n  import \"./Who\";\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "M.compact");
        let found = files.resolve(module, &[], "Badge").expect("resolves");
        assert!(matches!(found, Resolved::Unprefixed { import: 1, .. }));
        assert_eq!(found.decl().expect("found").name, "Badge");
        let missing = files.resolve(module, &[], "Elsewhere").expect("resolves");
        assert!(matches!(
            missing,
            Resolved::Unprefixed {
                import: 0,
                lookup: Lookup::Missing(_)
            }
        ));
    }

    /// A chain `M -> A1 -> ... -> A<hops>`, each module re-exporting `X` from the next and
    /// the last declaring it.
    fn chain(hops: usize) -> (tempfile::TempDir, Files, usize) {
        let mut sources = vec![(
            "M.compact".to_owned(),
            "module M { import { X } from \"./A1\"; }\n".to_owned(),
        )];
        for hop in 1..=hops {
            let body = if hop == hops {
                "export struct X { }".to_owned()
            } else {
                format!("import {{ X }} from \"./A{}\"; export {{ X }};", hop + 1)
            };
            sources.push((
                format!("A{hop}.compact"),
                format!("module A{hop} {{ {body} }}\n"),
            ));
        }
        let borrowed: Vec<(&str, &str)> = sources
            .iter()
            .map(|(path, text)| (path.as_str(), text.as_str()))
            .collect();
        let (root, mut files) = tree(&borrowed);
        let module = load(&mut files, root.path(), "M.compact");
        (root, files, module)
    }

    #[test]
    fn a_re_export_chain_resolves_up_to_the_depth_limit() {
        let (_root, mut files, module) = chain(MAX_DEPTH);
        let resolved = files.resolve(module, &[], "X").expect("resolves");
        assert_eq!(resolved.decl().expect("found").kind, DeclKind::Struct);
        let (_root, mut files, module) = chain(MAX_DEPTH + 1);
        let resolved = files.resolve(module, &[], "X").expect("resolves");
        assert!(matches!(resolved.lookup(), Some(Lookup::TooDeep)));
    }

    #[test]
    fn caller_matching_follows_aliases_imports_and_re_exports() {
        let (root, mut files) = tree(&[
            ("id/Id.compact", ID),
            (
                "id/Again.compact",
                "module Again {\n  import { Who } from \"./Id\";\n  export { Who };\n}\n",
            ),
            (
                "a/M.compact",
                "module M {\n  import { Who as Person } from \"../id/Again\";\n  import \"../id/Id\";\n  import { Nobody } from \"../id/Id\";\n  type One = Two;\n  type Two = Person;\n  type Some = Maybe<Person>;\n  new type Tag = One;\n  type Loop = Loop2;\n  type Loop2 = Loop;\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "a/M.compact");
        let id = load(&mut files, root.path(), "id/Id.compact");
        let caller = (id, "Who".to_owned());
        let mut check = |ty: &str| files.caller_match(module, &[], ty, &caller).expect("ok");
        assert_eq!(check("Person"), CallerMatch::Exact);
        assert_eq!(check("Who"), CallerMatch::Exact);
        assert_eq!(check("One"), CallerMatch::Exact);
        assert_eq!(check("Vector<2, Person>"), CallerMatch::Contains);
        assert_eq!(check("Some"), CallerMatch::Contains);
        assert_eq!(check("Tag"), CallerMatch::Contains);
        assert_eq!(check("Field"), CallerMatch::No);
        assert_eq!(check("Nobody"), CallerMatch::Unresolved);
        assert_eq!(check("Loop"), CallerMatch::Unresolved);
    }

    #[test]
    fn an_export_list_re_exports_names_from_whole_and_prefixed_imports() {
        let (root, mut files) = tree(&[
            ("id/Id.compact", ID),
            (
                "hub/Hub.compact",
                "module Hub {\n  import \"../id/Id\";\n  import \"../id/Id\" prefix Id_;\n  export { Who, Id_Who };\n}\n",
            ),
            (
                "hub/Quiet.compact",
                "module Quiet {\n  import \"../id/Id\";\n}\n",
            ),
            (
                "a/M.compact",
                "module M {\n  import \"../hub/Quiet\";\n  import \"../hub/Hub\";\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "a/M.compact");
        let id = load(&mut files, root.path(), "id/Id.compact");
        let caller = (id, "Who".to_owned());
        let mut check = |ty: &str| files.caller_match(module, &[], ty, &caller).expect("ok");
        assert_eq!(check("Who"), CallerMatch::Exact);
        assert_eq!(check("Id_Who"), CallerMatch::Exact);
        assert_eq!(check("Account"), CallerMatch::No);
        let resolved = files.resolve(module, &[], "Who").expect("resolves");
        assert!(matches!(resolved, Resolved::Unprefixed { import: 1, .. }));
    }

    #[test]
    fn a_cycle_of_whole_module_re_exports_does_not_resolve() {
        let (root, mut files) = tree(&[
            (
                "A.compact",
                "module A {\n  import \"./B\";\n  export { X };\n}\n",
            ),
            (
                "B.compact",
                "module B {\n  import \"./A\";\n  export { X };\n}\n",
            ),
            ("M.compact", "module M {\n  import \"./A\";\n}\n"),
        ]);
        let module = load(&mut files, root.path(), "M.compact");
        let resolved = files.resolve(module, &[], "X").expect("resolves");
        assert!(matches!(
            resolved,
            Resolved::Unprefixed {
                lookup: Lookup::TooDeep,
                ..
            }
        ));
        assert!(matches!(
            files.resolve(module, &[], "Maybe").expect("resolves"),
            Resolved::Std
        ));
        let caller = (module, "Nothing".to_owned());
        assert_eq!(
            files.caller_match(module, &[], "X", &caller).expect("ok"),
            CallerMatch::Unresolved
        );
    }

    #[test]
    fn a_declaration_named_by_the_module_export_list_is_exported() {
        let (root, mut files) = tree(&[(
            "M.compact",
            "module M {\n  struct Box { }\n  struct Kept { }\n  export { Box };\n}\n",
        )]);
        let module = load(&mut files, root.path(), "M.compact");
        let exported = |files: &mut Files, name: &str| {
            files
                .resolve(module, &[], name)
                .expect("resolves")
                .decl()
                .expect("found")
                .exported
        };
        assert!(exported(&mut files, "Box"));
        assert!(!exported(&mut files, "Kept"));
    }

    #[test]
    fn a_struct_holding_the_caller_type_contains_it() {
        let (root, mut files) = tree(&[
            ("id/Id.compact", ID),
            (
                "a/M.compact",
                "module M {\n  import { Who } from \"../id/Id\";\n  struct Held { who: Who; }\n  struct Outer { inner: Held, n: Field }\n  struct Slot<T> { item: T; }\n  struct Plain { n: Field; }\n}\n",
            ),
        ]);
        let module = load(&mut files, root.path(), "a/M.compact");
        let id = load(&mut files, root.path(), "id/Id.compact");
        let caller = (id, "Who".to_owned());
        let mut check = |ty: &str| files.caller_match(module, &[], ty, &caller).expect("ok");
        assert_eq!(check("Held"), CallerMatch::Contains);
        assert_eq!(check("Outer"), CallerMatch::Contains);
        assert_eq!(check("Slot<Who>"), CallerMatch::Contains);
        assert_eq!(check("Slot<Field>"), CallerMatch::No);
        assert_eq!(check("Plain"), CallerMatch::No);
    }

    #[test]
    fn the_file_cache_keys_by_canonical_path() {
        let (root, mut files) = tree(&[("a/M.compact", "module M { }\n")]);
        let first = load(&mut files, root.path(), "a/M.compact");
        let second = load(&mut files, root.path(), "a/../a/M.compact");
        assert_eq!(first, second);
        assert_eq!(
            files.load(&root.path().join("a/Gone.compact")).expect("ok"),
            None
        );
    }
}
