//! Declarations the linter checks, lifted out of the tree-sitter tree.

use std::fmt;

use tree_sitter::Node;

use crate::doc::{DocComment, TagOccurrence};
use crate::report::Position;

/// The declaration kinds the linter has rules for.
///
/// `pragma`, `include`, `import`, `export { … }` and `contract implements` are
/// never checked, so they have no variant here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeclKind {
    Module,
    Circuit,
    Ledger,
    Witness,
    Constructor,
    Struct,
    Enum,
    Contract,
    Type,
}

impl DeclKind {
    /// Maps a tree-sitter node kind, returning `None` for unchecked declarations.
    #[must_use]
    pub fn from_node_kind(node_kind: &str) -> Option<Self> {
        match node_kind {
            "module_declaration" => Some(Self::Module),
            "circuit_declaration" => Some(Self::Circuit),
            "ledger_declaration" => Some(Self::Ledger),
            "witness_declaration" => Some(Self::Witness),
            "constructor_declaration" => Some(Self::Constructor),
            "struct_declaration" => Some(Self::Struct),
            "enum_declaration" => Some(Self::Enum),
            "contract_declaration" => Some(Self::Contract),
            "type_declaration" => Some(Self::Type),
            _ => None,
        }
    }

    /// The name used in config keys and messages.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Module => "module",
            Self::Circuit => "circuit",
            Self::Ledger => "ledger",
            Self::Witness => "witness",
            Self::Constructor => "constructor",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Contract => "contract",
            Self::Type => "type",
        }
    }
}

impl fmt::Display for DeclKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One declaration with the facts the rules need.
#[derive(Clone, Debug)]
pub struct Declaration {
    pub kind: DeclKind,
    /// The `name` field; `constructor` has none.
    pub name: Option<String>,
    /// The declaration carries the `export` token itself; nesting never grants it.
    pub exported: bool,
    pub pure: bool,
    pub position: Position,
    /// The doc comment immediately preceding the declaration, if one attaches.
    pub doc: Option<AttachedDoc>,
}

/// A doc comment bound to a declaration, with the source line it starts on.
#[derive(Clone, Debug)]
pub struct AttachedDoc {
    pub comment: DocComment,
    /// 0-based row of the `/**` line, for turning a tag's offset into a position.
    pub start_row: usize,
    pub start_column: usize,
}

impl AttachedDoc {
    /// The position of a tag's `@`; a first-line offset is counted after the `/**`.
    #[must_use]
    pub const fn tag_position(&self, occurrence: &TagOccurrence) -> Position {
        let column = if occurrence.line_offset == 0 {
            self.start_column + "/**".len() + occurrence.column_offset
        } else {
            occurrence.column_offset
        };
        Position::from_zero_based(self.start_row + occurrence.line_offset, column)
    }
}

/// Collects every checked declaration, descending into module bodies.
#[must_use]
pub fn declarations(root: Node<'_>, source: &str) -> Vec<Declaration> {
    let mut found = Vec::new();
    collect(root, source, &mut found);
    found
}

fn collect(parent: Node<'_>, source: &str, out: &mut Vec<Declaration>) {
    let mut cursor = parent.walk();
    for node in parent.named_children(&mut cursor) {
        let Some(kind) = DeclKind::from_node_kind(node.kind()) else {
            continue;
        };

        out.push(declaration(kind, node, source));

        // Only modules nest; every other body is an opaque token run.
        if kind == DeclKind::Module
            && let Some(body) = node.child_by_field_name("body")
        {
            collect(body, source, out);
        }
    }
}

fn declaration(kind: DeclKind, node: Node<'_>, source: &str) -> Declaration {
    let mut cursor = node.walk();
    let mut exported = false;
    let mut pure = false;
    for child in node.children(&mut cursor) {
        match child.kind() {
            "export" => exported = true,
            "pure" => pure = true,
            _ => {}
        }
    }

    let name = node
        .child_by_field_name("name")
        .and_then(|name| text(name, source))
        .map(str::to_owned);

    let start = node.start_position();

    Declaration {
        kind,
        name,
        exported,
        pure,
        position: Position::from_zero_based(start.row, start.column),
        doc: attached_doc(node, source),
    }
}

/// A doc comment attaches only as the immediately preceding named sibling; a line
/// or block comment in between breaks the attachment.
fn attached_doc(node: Node<'_>, source: &str) -> Option<AttachedDoc> {
    let previous = node.prev_named_sibling()?;
    if previous.kind() != "doc_comment" {
        return None;
    }

    let start = previous.start_position();
    Some(AttachedDoc {
        comment: DocComment::parse(text(previous, source)?),
        start_row: start.row,
        start_column: start.column,
    })
}

fn text<'a>(node: Node<'_>, source: &'a str) -> Option<&'a str> {
    source.get(node.start_byte()..node.end_byte())
}
