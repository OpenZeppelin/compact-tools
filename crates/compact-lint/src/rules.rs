//! The doc-comment rules, run over one parsed file at a time.
//!
//! Detection yields [`Issue`]s. `check` renders them as [`Finding`]s and `fix` renders
//! the fixable ones as edits, so both subcommands read the same detection pass.

use std::ops::Range;
use std::path::{Path, PathBuf};

use thiserror::Error;
use tree_sitter::{Node, Parser};

use crate::config::{Config, DocsPolicy};
use crate::doc::Tag;
use crate::model::{DeclKind, Declaration, declarations};
use crate::report::{Finding, Position, RuleId};

#[derive(Debug, Error)]
pub enum LintError {
    #[error("the bundled Compact grammar does not match the linked tree-sitter ABI")]
    Language(#[source] tree_sitter::LanguageError),
    #[error("tree-sitter returned no parse tree for {0}")]
    NoTree(PathBuf),
}

/// Where a doc comment sits in the file, for the rules that rewrite one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocRef {
    /// Byte range of the `/** … */` node.
    pub range: Range<usize>,
    /// Column the `/**` starts on, reused as the rewritten comment's indentation.
    pub indent: usize,
}

/// One rule violation, carrying what `check` prints and what `fix` needs to repair it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Issue {
    Parse {
        position: Position,
        node_kind: String,
        missing: bool,
    },
    MissingDoc {
        position: Position,
        subject: String,
        kind: DeclKind,
        name: Option<String>,
        /// Byte offset of the declaration's first token.
        offset: usize,
        /// The declaration's start column, reused as the skeleton's indentation.
        indent: usize,
        /// The declaration also carries the constraints annotation.
        constraints: bool,
    },
    MissingTag {
        position: Position,
        subject: String,
        kind: DeclKind,
        tag: Tag,
        /// The declaration's name, which `@module` takes as its value.
        name: Option<String>,
        doc: DocRef,
    },
    ForbiddenTag {
        position: Position,
        tag: Tag,
        /// 0-based line index of the tag inside the doc comment.
        line_offset: usize,
        doc: DocRef,
    },
    ModuleName {
        position: Position,
        documented: String,
        name: String,
        /// 0-based line index of `@module` inside the doc comment.
        line_offset: usize,
        doc: DocRef,
    },
    MissingConstraints {
        position: Position,
        subject: String,
        tag: Tag,
        doc: DocRef,
    },
    ConstraintsFormat {
        position: Position,
        tag: Tag,
        value: String,
    },
    ConstraintsPlaceholder {
        position: Position,
        tag: Tag,
        value: String,
    },
}

impl Issue {
    #[must_use]
    pub const fn position(&self) -> Position {
        match self {
            Self::Parse { position, .. }
            | Self::MissingDoc { position, .. }
            | Self::MissingTag { position, .. }
            | Self::ForbiddenTag { position, .. }
            | Self::ModuleName { position, .. }
            | Self::MissingConstraints { position, .. }
            | Self::ConstraintsFormat { position, .. }
            | Self::ConstraintsPlaceholder { position, .. } => *position,
        }
    }

    #[must_use]
    pub const fn rule(&self) -> RuleId {
        match self {
            Self::Parse { .. } => RuleId::PARSE,
            Self::MissingDoc { .. } => RuleId::MISSING_DOC,
            Self::MissingTag { .. } => RuleId::MISSING_TAG,
            Self::ForbiddenTag { .. } => RuleId::FORBIDDEN_TAG,
            Self::ModuleName { .. } => RuleId::MODULE_NAME,
            Self::MissingConstraints { .. } => RuleId::MISSING_CONSTRAINTS,
            Self::ConstraintsFormat { .. } => RuleId::CONSTRAINTS_FORMAT,
            Self::ConstraintsPlaceholder { .. } => RuleId::CONSTRAINTS_PLACEHOLDER,
        }
    }

    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Parse {
                node_kind, missing, ..
            } => {
                if *missing {
                    format!("parse error: missing {node_kind}")
                } else {
                    format!("parse error: unexpected {node_kind}")
                }
            }
            Self::MissingDoc { subject, .. } => format!("{subject} has no doc comment"),
            Self::MissingTag { subject, tag, .. }
            | Self::MissingConstraints { subject, tag, .. } => {
                format!("{subject} doc comment has no {tag}")
            }
            Self::ForbiddenTag { tag, .. } => format!("forbidden tag {tag}"),
            Self::ModuleName {
                documented, name, ..
            } => format!("@module names `{documented}`, but the module is `{name}`"),
            Self::ConstraintsFormat { tag, value, .. } => {
                format!("{tag} value `{value}` is not `k=<n>, rows=<n>`")
            }
            Self::ConstraintsPlaceholder { tag, value, .. } => {
                format!("{tag} value `{value}` still holds a placeholder")
            }
        }
    }

    #[must_use]
    pub fn finding(&self, display: &Path) -> Finding {
        Finding::new(display, self.position(), self.rule(), self.message())
    }
}

/// A reusable parser plus the rules that run over its trees.
pub struct Linter {
    parser: Parser,
}

impl Linter {
    /// # Errors
    /// Returns an error when the bundled grammar does not match the linked ABI.
    pub fn new() -> Result<Self, LintError> {
        let mut parser = Parser::new();
        parser
            .set_language(&compact_tree_sitter::LANGUAGE.into())
            .map_err(LintError::Language)?;
        Ok(Self { parser })
    }

    /// Runs every rule over one file, in source order.
    ///
    /// A tree holding an `ERROR` or `MISSING` node yields a single `parse` issue and no
    /// doc issues, because declarations around the defect are not trustworthy.
    /// # Errors
    /// Returns an error when tree-sitter produces no tree for `source`.
    pub fn issues(
        &mut self,
        display: &Path,
        source: &str,
        config: &Config,
        strict: bool,
    ) -> Result<Vec<Issue>, LintError> {
        let tree = self
            .parser
            .parse(source, None)
            .ok_or_else(|| LintError::NoTree(display.to_owned()))?;
        let root = tree.root_node();

        if let Some(defect) = first_defect(root) {
            return Ok(vec![defect]);
        }

        let mut issues = Vec::new();
        for declaration in declarations(root, source) {
            check_declaration(&declaration, config, strict, &mut issues);
        }
        issues.sort_by_key(|issue| (issue.position(), issue.rule()));
        Ok(issues)
    }

    /// Checks one file. `display` is the path printed in findings.
    /// # Errors
    /// Returns an error when tree-sitter produces no tree for `source`.
    pub fn check(
        &mut self,
        display: &Path,
        source: &str,
        config: &Config,
        strict: bool,
    ) -> Result<Vec<Finding>, LintError> {
        Ok(self
            .issues(display, source, config, strict)?
            .iter()
            .map(|issue| issue.finding(display))
            .collect())
    }
}

/// The first `ERROR` or `MISSING` node in document order.
fn first_defect(node: Node<'_>) -> Option<Issue> {
    if node.is_error() || node.is_missing() {
        let start = node.start_position();
        return Some(Issue::Parse {
            position: Position::from_zero_based(start.row, start.column),
            node_kind: node.kind().to_owned(),
            missing: node.is_missing(),
        });
    }

    if !node.has_error() {
        return None;
    }

    let mut cursor = node.walk();
    node.children(&mut cursor).find_map(first_defect)
}

fn check_declaration(
    declaration: &Declaration,
    config: &Config,
    strict: bool,
    issues: &mut Vec<Issue>,
) {
    let kind_config = config.kinds.get(declaration.kind);
    let requires_docs = match kind_config.docs {
        DocsPolicy::All => true,
        DocsPolicy::Exported => declaration.exported,
        DocsPolicy::None => false,
    };

    let Some(attached) = declaration.doc.as_ref() else {
        if requires_docs {
            issues.push(Issue::MissingDoc {
                position: declaration.position,
                subject: subject(declaration),
                kind: declaration.kind,
                name: declaration.name.clone(),
                offset: declaration.offset,
                indent: declaration.position.column - 1,
                constraints: takes_constraints(declaration),
            });
        }
        return;
    };

    let doc = DocRef {
        range: attached.range.clone(),
        indent: attached.start_column,
    };

    // A forbidden tag is an issue wherever it appears, documented or not.
    for forbidden in &config.tags.forbid {
        for occurrence in attached.comment.tags() {
            if &occurrence.tag == forbidden {
                issues.push(Issue::ForbiddenTag {
                    position: attached.tag_position(occurrence),
                    tag: forbidden.clone(),
                    line_offset: occurrence.line_offset,
                    doc: doc.clone(),
                });
            }
        }
    }

    if declaration.kind == DeclKind::Module {
        check_module_name(declaration, &doc, issues);
    }

    if !requires_docs {
        return;
    }

    for required in &kind_config.tags {
        if !attached.comment.has(required) {
            issues.push(Issue::MissingTag {
                position: declaration.position,
                subject: subject(declaration),
                kind: declaration.kind,
                tag: required.clone(),
                name: declaration.name.clone(),
                doc: doc.clone(),
            });
        }
    }

    check_constraints(declaration, &doc, config, strict, issues);
}

/// `@module <Name>` must name the module it documents.
fn check_module_name(declaration: &Declaration, doc: &DocRef, issues: &mut Vec<Issue>) {
    let tag = Tag::new("@module");
    let (Some(attached), Some(name)) = (declaration.doc.as_ref(), declaration.name.as_deref())
    else {
        return;
    };
    let Some(occurrence) = attached.comment.first(&tag) else {
        return;
    };

    let documented = module_name(&occurrence.value);
    if documented != name {
        issues.push(Issue::ModuleName {
            position: attached.tag_position(occurrence),
            documented: documented.to_owned(),
            name: name.to_owned(),
            line_offset: occurrence.line_offset,
            doc: doc.clone(),
        });
    }
}

/// The documented name is the first word, without generic arguments or trailing punctuation.
fn module_name(value: &str) -> &str {
    let first = value.split_whitespace().next().unwrap_or_default();
    let without_generics = first.split('<').next().unwrap_or(first);
    without_generics.trim_end_matches(['.', ',', ':', ';'])
}

/// Exported non-pure circuits carry the constraints annotation.
const fn takes_constraints(declaration: &Declaration) -> bool {
    matches!(declaration.kind, DeclKind::Circuit) && declaration.exported && !declaration.pure
}

fn check_constraints(
    declaration: &Declaration,
    doc: &DocRef,
    config: &Config,
    strict: bool,
    issues: &mut Vec<Issue>,
) {
    if !takes_constraints(declaration) {
        return;
    }
    let Some(attached) = declaration.doc.as_ref() else {
        return;
    };
    let tag = &config.constraints.tag;

    let Some(occurrence) = attached.comment.first(tag) else {
        issues.push(Issue::MissingConstraints {
            position: declaration.position,
            subject: subject(declaration),
            tag: tag.clone(),
            doc: doc.clone(),
        });
        return;
    };

    // The annotation is one line; anything below it is prose, not part of the value.
    let value = occurrence.value.lines().next().unwrap_or_default().trim();
    let position = attached.tag_position(occurrence);

    let Some(placeholders) = parse_constraints(value) else {
        issues.push(Issue::ConstraintsFormat {
            position,
            tag: tag.clone(),
            value: value.to_owned(),
        });
        return;
    };

    if strict && placeholders {
        issues.push(Issue::ConstraintsPlaceholder {
            position,
            tag: tag.clone(),
            value: value.to_owned(),
        });
    }
}

/// Matches `k=<n|?>,<space>*rows=<n|?>`; returns whether either field is a `?` placeholder.
fn parse_constraints(value: &str) -> Option<bool> {
    let rest = value.strip_prefix("k=")?;
    let (k, rest) = rest.split_once(',')?;
    let rows = rest.trim_start().strip_prefix("rows=")?;

    let k_placeholder = is_placeholder(k)?;
    let rows_placeholder = is_placeholder(rows)?;
    Some(k_placeholder || rows_placeholder)
}

/// A constraints field is either a decimal count or a `?` placeholder.
fn is_placeholder(field: &str) -> Option<bool> {
    match field {
        "?" => Some(true),
        digits if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) => {
            Some(false)
        }
        _ => None,
    }
}

/// The kind plus the backquoted name, or a bare kind when the declaration has no name.
fn subject(declaration: &Declaration) -> String {
    match declaration.name.as_deref() {
        Some(name) => format!("{} `{name}`", declaration.kind),
        None => declaration.kind.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{Linter, module_name, parse_constraints};
    use crate::config::{Config, DocsPolicy};
    use crate::doc::Tag;
    use std::path::Path;

    fn findings(source: &str, config: &Config, strict: bool) -> Vec<String> {
        Linter::new()
            .expect("the bundled grammar loads")
            .check(Path::new("a.compact"), source, config, strict)
            .expect("the source produced a tree")
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    fn circuit_config() -> Config {
        let mut config = Config::default();
        config.kinds.circuit.tags = vec![Tag::new("@description")];
        config
    }

    #[test]
    fn a_non_exported_circuit_inside_an_exported_module_needs_no_docs() {
        let source = "/** @description M. */\nexport module M {\n  circuit helper(): [] { }\n}\n";

        assert!(findings(source, &Config::default(), false).is_empty());
    }

    #[test]
    fn an_exported_module_without_a_doc_comment_is_reported() {
        let source = "export module M {\n}\n";

        assert_eq!(
            findings(source, &Config::default(), false),
            ["a.compact:1:1: missing-doc: module `M` has no doc comment"]
        );
    }

    #[test]
    fn a_line_comment_between_the_doc_and_the_declaration_breaks_attachment() {
        let source = "/** @description M. */\n// a note\nexport module M {\n}\n";

        assert_eq!(
            findings(source, &Config::default(), false),
            ["a.compact:3:1: missing-doc: module `M` has no doc comment"]
        );
    }

    #[test]
    fn a_pure_exported_circuit_needs_no_constraints() {
        let source = "/** @description Adds. */\nexport pure circuit add(a: Uint<8>): Uint<8> { return a; }\n";

        assert!(findings(source, &circuit_config(), false).is_empty());
    }

    #[test]
    fn an_exported_circuit_without_constraints_is_reported() {
        let source =
            "/** @description Bumps. */\nexport circuit bump(): [] { count.increment(1); }\n";

        assert_eq!(
            findings(source, &circuit_config(), false),
            ["a.compact:2:1: missing-constraints: circuit `bump` doc comment has no @constraints"]
        );
    }

    #[test]
    fn a_placeholder_is_a_finding_only_under_strict() {
        let source = "/**\n * @description Bumps.\n * @constraints k=?, rows=?\n */\nexport circuit bump(): [] { }\n";
        let config = circuit_config();

        assert!(findings(source, &config, false).is_empty());
        assert_eq!(
            findings(source, &config, true),
            [
                "a.compact:3:4: constraints-placeholder: @constraints value `k=?, rows=?` still holds a placeholder"
            ]
        );
    }

    #[test]
    fn a_forbidden_tag_is_reported_even_where_docs_are_optional() {
        let source = "/**\n * @return nothing\n */\ncircuit hidden(): [] { }\n";
        let mut config = Config::default();
        config.tags.forbid = vec![Tag::new("@return")];

        assert_eq!(
            findings(source, &config, false),
            ["a.compact:2:4: forbidden-tag: forbidden tag @return"]
        );
    }

    #[test]
    fn a_witness_under_docs_all_is_checked_without_export() {
        let source = "witness wit_secret(): Bytes<32>;\n";
        let mut config = Config::default();
        config.kinds.witness.docs = DocsPolicy::All;

        assert_eq!(
            findings(source, &config, false),
            ["a.compact:1:1: missing-doc: witness `wit_secret` has no doc comment"]
        );
    }

    #[test]
    fn a_parse_defect_suppresses_the_doc_rules() {
        let source = "export module M {\nexport circuit\n";

        let reported = findings(source, &Config::default(), false);
        assert_eq!(reported.len(), 1, "{reported:?}");
        assert!(reported[0].contains("parse error"), "{reported:?}");
    }

    #[test]
    fn the_constraints_tag_is_configurable() {
        let source = "/**\n * @description Bumps.\n * @circuitInfo k=6, rows=28\n */\nexport circuit bump(): [] { }\n";
        let mut config = circuit_config();
        config.constraints.tag = Tag::new("@circuitInfo");

        assert!(findings(source, &config, false).is_empty());
    }

    #[test]
    fn constraints_accept_flexible_spacing_after_the_comma() {
        assert_eq!(parse_constraints("k=10, rows=626"), Some(false));
        assert_eq!(parse_constraints("k=10,rows=626"), Some(false));
        assert_eq!(parse_constraints("k=?, rows=626"), Some(true));
        assert_eq!(parse_constraints("k=10, rows=626 (approx)"), None);
        assert_eq!(parse_constraints("rows=626, k=10"), None);
    }

    #[test]
    fn a_documented_module_name_drops_generics_and_trailing_punctuation() {
        assert_eq!(module_name("Signer<T>"), "Signer");
        assert_eq!(module_name("Utils."), "Utils");
        assert_eq!(module_name("ShieldedToken (archived)"), "ShieldedToken");
    }
}
