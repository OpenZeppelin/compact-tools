//! One Compact file, parsed with `compact-tree-sitter` into the declarations the
//! generator reads.

use std::path::{Path, PathBuf};

use tree_sitter::{Node, Parser};

use crate::params::{self, RawParam};

/// A parsed file.
#[derive(Clone, Debug)]
pub struct SourceFile {
    /// Absolute and lexically normalized.
    pub path: PathBuf,
    /// The first top-level `pragma` declaration, verbatim.
    pub pragma: Option<String>,
    /// Top-level module declarations found.
    pub module_count: usize,
    /// The first top-level module.
    pub module: Option<Module>,
    /// Whether a top-level `constructor` is declared.
    pub has_constructor: bool,
}

#[derive(Clone, Debug)]
pub struct Module {
    pub name: String,
    pub generics: Vec<GenericParam>,
    /// Imports inside the module body, in source order.
    pub imports: Vec<Import>,
    /// Declarations inside the module body, in source order.
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenericParam {
    pub name: String,
    /// `#n`: a size parameter.
    pub numeric: bool,
}

#[derive(Clone, Debug)]
pub struct Import {
    /// Empty for a whole-module import.
    pub selection: Vec<ImportElement>,
    pub target: ImportTarget,
    /// The `<...>` text, whitespace-collapsed.
    pub generic_args: Option<String>,
    pub prefix: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportTarget {
    /// `import CompactStandardLibrary;`
    Library(String),
    /// A path string, unquoted.
    Path(String),
}

#[derive(Clone, Debug)]
pub struct ImportElement {
    pub name: String,
    pub alias: Option<String>,
}

impl ImportElement {
    /// The name the importing module uses.
    #[must_use]
    pub fn local(&self) -> &str {
        self.alias.as_deref().unwrap_or(&self.name)
    }

    /// The element as written: `name` or `name as alias`.
    #[must_use]
    pub fn spelled(&self) -> String {
        match &self.alias {
            Some(alias) => format!("{} as {alias}", self.name),
            None => self.name.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub enum Item {
    Circuit(Circuit),
    Witness(Witness),
    Ledger(Ledger),
    Type(TypeDecl),
    /// `export { a, b }` inside the module.
    ExportList(Vec<String>),
}

impl Item {
    /// The declared name; an export list declares none.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Circuit(circuit) => Some(&circuit.name),
            Self::Witness(witness) => Some(&witness.name),
            Self::Ledger(ledger) => Some(&ledger.name),
            Self::Type(decl) => Some(&decl.name),
            Self::ExportList(_) => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Circuit {
    pub name: String,
    pub exported: bool,
    pub pure: bool,
    pub generics: Vec<GenericParam>,
    pub params: Vec<RawParam>,
    /// Return type, whitespace-collapsed.
    pub ret: String,
}

#[derive(Clone, Debug)]
pub struct Witness {
    pub name: String,
    pub exported: bool,
}

#[derive(Clone, Debug)]
pub struct Ledger {
    pub name: String,
    pub exported: bool,
    pub sealed: bool,
    pub ty: String,
}

#[derive(Clone, Debug)]
pub struct TypeDecl {
    pub name: String,
    pub exported: bool,
    pub kind: TypeKind,
    pub generics: Vec<GenericParam>,
    /// A struct's field types, whitespace-collapsed; empty for an enum or alias.
    pub fields: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TypeKind {
    Struct,
    Enum,
    /// `type X = rhs;`, or `new type X = rhs;` when `nominal`.
    Alias {
        rhs: String,
        nominal: bool,
    },
}

/// Why a file did not parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseFailure {
    /// The bundled grammar does not load, or tree-sitter returned no tree.
    NoTree,
    /// 1-based line and column of the first defect.
    At { line: usize, column: usize },
}

/// Parses `text` read from `path`.
/// # Errors
/// Returns the first `ERROR` or `MISSING` node, or the first malformed parameter list.
pub fn parse(path: &Path, text: &str) -> Result<SourceFile, ParseFailure> {
    let mut parser = Parser::new();
    parser
        .set_language(&compact_tree_sitter::LANGUAGE.into())
        .map_err(|_| ParseFailure::NoTree)?;
    let tree = parser.parse(text, None).ok_or(ParseFailure::NoTree)?;
    let root = tree.root_node();
    if let Some(defect) = first_defect(root) {
        return Err(position(text, defect.start_byte()));
    }

    let mut file = SourceFile {
        path: path.to_owned(),
        pragma: None,
        module_count: 0,
        module: None,
        has_constructor: false,
    };
    let mut cursor = root.walk();
    for node in root.named_children(&mut cursor) {
        match node.kind() {
            "pragma_declaration" if file.pragma.is_none() => {
                file.pragma = Some(slice(node, text).to_owned());
            }
            "constructor_declaration" => file.has_constructor = true,
            "module_declaration" => {
                file.module_count += 1;
                if file.module.is_none() {
                    file.module = Some(module(node, text)?);
                }
            }
            _ => {}
        }
    }
    Ok(file)
}

fn first_defect(node: Node<'_>) -> Option<Node<'_>> {
    if node.is_error() || node.is_missing() {
        return Some(node);
    }
    if !node.has_error() {
        return None;
    }
    let mut cursor = node.walk();
    node.children(&mut cursor).find_map(first_defect)
}

/// 1-based line and column (in characters) of a byte offset.
fn position(text: &str, offset: usize) -> ParseFailure {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let before = &text[..offset];
    let line = before.matches('\n').count() + 1;
    let line_start = before.rfind('\n').map_or(0, |at| at + 1);
    let column = before[line_start..].chars().count() + 1;
    ParseFailure::At { line, column }
}

fn module(node: Node<'_>, text: &str) -> Result<Module, ParseFailure> {
    let mut module = Module {
        name: field_text(node, "name", text),
        generics: generic_parameters(node, text),
        imports: Vec::new(),
        items: Vec::new(),
    };
    let Some(body) = node.child_by_field_name("body") else {
        return Ok(module);
    };
    let mut cursor = body.walk();
    for child in body.named_children(&mut cursor) {
        match child.kind() {
            "import_declaration" => module.imports.push(import(child, text)),
            "export_declaration" => {
                let mut inner = child.walk();
                let names = child
                    .named_children(&mut inner)
                    .filter(|name| name.kind() == "identifier")
                    .map(|name| slice(name, text).to_owned())
                    .collect();
                module.items.push(Item::ExportList(names));
            }
            "circuit_declaration" => module.items.push(Item::Circuit(circuit(child, text)?)),
            "witness_declaration" => module.items.push(Item::Witness(Witness {
                name: field_text(child, "name", text),
                exported: has_token(child, "export"),
            })),
            "ledger_declaration" => module.items.push(Item::Ledger(Ledger {
                name: field_text(child, "name", text),
                exported: has_token(child, "export"),
                sealed: has_token(child, "sealed"),
                ty: type_text(child.child_by_field_name("type"), text),
            })),
            "struct_declaration" | "enum_declaration" | "type_declaration" => {
                module.items.push(Item::Type(type_decl(child, text)));
            }
            _ => {}
        }
    }
    Ok(module)
}

fn import(node: Node<'_>, text: &str) -> Import {
    let mut selection = Vec::new();
    let mut generic_args = None;
    let mut prefix = None;
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "import_selection" => {
                let mut inner = child.walk();
                for element in child.named_children(&mut inner) {
                    if element.kind() == "import_element" {
                        selection.push(ImportElement {
                            name: field_text(element, "name", text),
                            alias: element
                                .child_by_field_name("alias")
                                .map(|alias| slice(alias, text).to_owned()),
                        });
                    }
                }
            }
            "generic_arguments" => generic_args = Some(type_text(Some(child), text)),
            "import_prefix" => prefix = Some(field_text(child, "prefix", text)),
            _ => {}
        }
    }
    let target = match node.child_by_field_name("name") {
        Some(name) if name.kind() == "string" => {
            let quoted = slice(name, text);
            let unquoted = quoted.get(1..quoted.len() - 1).unwrap_or_default();
            ImportTarget::Path(unquoted.to_owned())
        }
        Some(name) => ImportTarget::Library(slice(name, text).to_owned()),
        None => ImportTarget::Library(String::new()),
    };
    Import {
        selection,
        target,
        generic_args,
        prefix,
    }
}

fn circuit(node: Node<'_>, text: &str) -> Result<Circuit, ParseFailure> {
    let params = match node.child_by_field_name("parameters") {
        Some(list) => params::split(&blanked(list, text))
            .map_err(|at| position(text, list.start_byte() + at))?,
        None => Vec::new(),
    };
    Ok(Circuit {
        name: field_text(node, "name", text),
        exported: has_token(node, "export"),
        pure: has_token(node, "pure"),
        generics: generic_parameters(node, text),
        params,
        ret: type_text(node.child_by_field_name("type"), text),
    })
}

fn type_decl(node: Node<'_>, text: &str) -> TypeDecl {
    let kind = match node.kind() {
        "struct_declaration" => TypeKind::Struct,
        "enum_declaration" => TypeKind::Enum,
        _ => TypeKind::Alias {
            rhs: type_text(node.child_by_field_name("value"), text),
            nominal: has_token(node, "new"),
        },
    };
    let fields = match (&kind, node.child_by_field_name("body")) {
        (TypeKind::Struct, Some(body)) => params::field_types(&blanked(body, text)),
        _ => Vec::new(),
    };
    TypeDecl {
        name: field_text(node, "name", text),
        exported: has_token(node, "export"),
        kind,
        generics: generic_parameters(node, text),
        fields,
    }
}

fn generic_parameters(node: Node<'_>, text: &str) -> Vec<GenericParam> {
    let mut cursor = node.walk();
    let Some(list) = node
        .named_children(&mut cursor)
        .find(|child| child.kind() == "generic_parameters")
    else {
        return Vec::new();
    };
    let mut inner = list.walk();
    list.named_children(&mut inner)
        .filter(|param| param.kind() == "generic_parameter")
        .map(|param| GenericParam {
            name: field_text(param, "name", text),
            numeric: has_token(param, "#"),
        })
        .collect()
}

/// Whether `node` has the anonymous token `kind` as a direct child.
fn has_token(node: Node<'_>, kind: &str) -> bool {
    let mut cursor = node.walk();
    node.children(&mut cursor)
        .any(|child| !child.is_named() && child.kind() == kind)
}

fn field_text(node: Node<'_>, field: &str, text: &str) -> String {
    node.child_by_field_name(field)
        .map(|child| slice(child, text).to_owned())
        .unwrap_or_default()
}

fn slice<'a>(node: Node<'_>, text: &'a str) -> &'a str {
    &text[node.byte_range()]
}

/// The node's text with comments blanked and whitespace collapsed.
fn type_text(node: Option<Node<'_>>, text: &str) -> String {
    node.map(|node| params::collapse(&blanked(node, text)))
        .unwrap_or_default()
}

/// The node's text with every comment inside it replaced by spaces of the same length.
fn blanked(node: Node<'_>, text: &str) -> String {
    let start = node.start_byte();
    let mut out = slice(node, text).to_owned();
    let mut comments = Vec::new();
    collect_comments(node, &mut comments);
    for (from, to) in comments {
        let range = (from - start)..(to - start);
        let spaces = " ".repeat(out[range.clone()].len());
        out.replace_range(range, &spaces);
    }
    out
}

fn collect_comments(node: Node<'_>, out: &mut Vec<(usize, usize)>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if matches!(
            child.kind(),
            "line_comment" | "block_comment" | "doc_comment"
        ) {
            out.push((child.start_byte(), child.end_byte()));
        } else {
            collect_comments(child, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{ImportTarget, Item, ParseFailure, TypeKind, parse, position};

    const COMMENTS: &str = include_str!("../tests/fixtures/parser/Comments.compact");

    const MODULE: &str = include_str!("../tests/fixtures/parser/Sample.compact");

    #[test]
    fn every_declaration_kind_is_read() {
        let file = parse(Path::new("/m/Sample.compact"), MODULE).expect("the module parses");
        assert_eq!(
            file.pragma.as_deref(),
            Some("pragma language_version >= 0.28.0;")
        );
        assert_eq!(file.module_count, 1);
        assert!(!file.has_constructor);

        let module = file.module.expect("a module");
        assert_eq!(module.name, "Sample");
        assert_eq!(module.generics.len(), 2);
        assert!(module.generics[0].numeric);
        assert!(!module.generics[1].numeric);

        assert_eq!(module.imports.len(), 3);
        assert_eq!(
            module.imports[0].target,
            ImportTarget::Library("CompactStandardLibrary".to_owned())
        );
        assert_eq!(module.imports[1].selection[1].local(), "Renamed");
        assert_eq!(module.imports[1].selection[1].spelled(), "Other as Renamed");
        assert_eq!(
            module.imports[2].target,
            ImportTarget::Path("./Helper".to_owned())
        );
        assert_eq!(
            module.imports[2].generic_args.as_deref(),
            Some("<Bytes<32>>")
        );
        assert_eq!(module.imports[2].prefix.as_deref(), Some("Helper_"));

        let Item::ExportList(names) = &module.items[0] else {
            panic!("the export list comes first");
        };
        assert_eq!(names, &["_shared"]);

        let Item::Type(wide) = &module.items[3] else {
            panic!("the alias is the fourth item");
        };
        assert_eq!(
            wide.kind,
            TypeKind::Alias {
                rhs: "Either<Bytes<32>, ContractAddress>".to_owned(),
                nominal: false
            }
        );
        let Item::Type(tag) = &module.items[4] else {
            panic!("the nominal alias is the fifth item");
        };
        assert!(matches!(tag.kind, TypeKind::Alias { nominal: true, .. }));

        let Item::Ledger(salt) = &module.items[5] else {
            panic!("the sealed ledger is the sixth item");
        };
        assert!(salt.exported && salt.sealed);

        let Item::Circuit(hash) = &module.items[8] else {
            panic!("the pure circuit is the ninth item");
        };
        assert!(hash.exported && hash.pure);
        assert_eq!(hash.generics[0].name, "k");
        assert_eq!(hash.params.len(), 2);
        assert_eq!(hash.params[0].ty, "Vector<k, Field>");
        assert_eq!(hash.ret, "Bytes<32>");

        let Item::Circuit(helper) = &module.items[9] else {
            panic!("the helper is the last item");
        };
        assert!(!helper.exported);
        assert_eq!(helper.params[0].name(), None);
    }

    #[test]
    fn a_syntax_error_reports_its_position() {
        let failure = parse(Path::new("/m/Bad.compact"), "module M {\n  circuit (\n}\n");
        assert!(matches!(failure, Err(ParseFailure::At { line: 2, .. })));
    }

    #[test]
    fn modules_and_constructors_are_counted() {
        let file = parse(
            Path::new("/m/Two.compact"),
            "module A { }\nmodule B { }\nconstructor() { }\n",
        )
        .expect("the file parses");
        assert_eq!(file.module_count, 2);
        assert!(file.has_constructor);
        assert!(file.pragma.is_none());
    }

    #[test]
    fn comments_are_blanked_in_every_type_text_and_the_first_pragma_is_verbatim() {
        let file = parse(Path::new("/m/Comments.compact"), COMMENTS).expect("the module parses");
        assert_eq!(
            file.pragma.as_deref(),
            Some("pragma language_version   >=   0.28.0;")
        );
        let module = file.module.expect("a module");
        assert_eq!(
            module.imports[1].generic_args.as_deref(),
            Some("<Bytes< 32>>")
        );
        let mut texts = Vec::new();
        for item in &module.items {
            match item {
                Item::Ledger(ledger) => texts.push(ledger.ty.clone()),
                Item::Type(decl) => {
                    if let TypeKind::Alias { rhs, .. } = &decl.kind {
                        texts.push(rhs.clone());
                    }
                }
                Item::Circuit(circuit) => {
                    texts.extend(circuit.params.iter().map(|param| param.ty.clone()));
                    texts.push(circuit.ret.clone());
                }
                _ => {}
            }
        }
        assert_eq!(
            texts,
            [
                "Map< Uint<64>, Bytes<32> >",
                "Either< Field, Uint<8>>",
                "Field",
                "Opaque<\"x  y\">",
                "Either< Field, Uint<8> >",
            ]
        );
    }

    #[test]
    fn export_flags_and_type_kinds_are_read_per_declaration() {
        let module = parse(Path::new("/m/Comments.compact"), COMMENTS)
            .expect("the module parses")
            .module
            .expect("a module");
        let flags: Vec<(String, bool)> = module
            .items
            .iter()
            .filter_map(|item| {
                let exported = match item {
                    Item::Witness(witness) => witness.exported,
                    Item::Type(decl) => decl.exported,
                    _ => return None,
                };
                Some((item.name()?.to_owned(), exported))
            })
            .collect();
        assert_eq!(
            flags,
            [
                ("Pair".to_owned(), true),
                ("wit_seed".to_owned(), true),
                ("wit_hidden".to_owned(), false),
                ("Mode".to_owned(), true),
                ("Hidden".to_owned(), false),
            ]
        );
        let kinds: Vec<&TypeKind> = module
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Type(decl) => Some(&decl.kind),
                _ => None,
            })
            .collect();
        assert!(matches!(kinds[1], TypeKind::Enum));
        assert!(matches!(kinds[2], TypeKind::Struct));
    }

    #[test]
    fn a_struct_keeps_its_type_parameters_and_field_types_without_comments() {
        let module = parse(
            Path::new("/m/Box.compact"),
            "module M {\n  struct Box<T> { a: T; /* b: Wrong; */ c: Maybe<Who>, }\n}\n",
        )
        .expect("the module parses")
        .module
        .expect("a module");
        let Item::Type(boxed) = &module.items[0] else {
            panic!("the struct is the only item");
        };
        assert_eq!(boxed.generics[0].name, "T");
        assert_eq!(boxed.fields, ["T", "Maybe<Who>"]);
    }

    #[test]
    fn a_crlf_module_parses_like_its_lf_copy() {
        let lf = parse(Path::new("/m/Sample.compact"), MODULE).expect("LF parses");
        let crlf = parse(
            Path::new("/m/Sample.compact"),
            &MODULE.replace('\n', "\r\n"),
        )
        .expect("CRLF parses");
        assert_eq!(lf.pragma, crlf.pragma);
        assert_eq!(format!("{:?}", lf.module), format!("{:?}", crlf.module));
    }

    #[test]
    fn a_parse_position_counts_lines_and_characters_from_one() {
        assert_eq!(
            position("\u{e9} x", 3),
            ParseFailure::At { line: 1, column: 3 }
        );
        assert_eq!(
            position("a\n\u{1f642}b", 6),
            ParseFailure::At { line: 2, column: 2 }
        );
        assert_eq!(position("ab", 99), ParseFailure::At { line: 1, column: 3 });
    }

    #[test]
    fn a_missing_token_is_a_parse_error() {
        let failure = parse(
            Path::new("/m/Missing.compact"),
            "module M {\n  export ledger x: Field\n}\n",
        );
        assert!(
            matches!(failure, Err(ParseFailure::At { .. })),
            "{failure:?}"
        );
    }
}
