//! The doc-comment rules, run over one parsed file at a time.

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

    /// Checks one file. `display` is the path printed in findings.
    ///
    /// A tree holding an `ERROR` or `MISSING` node yields a single `parse` finding and
    /// no doc findings, because declarations around the defect are not trustworthy.
    /// # Errors
    /// Returns an error when tree-sitter produces no tree for `source`.
    pub fn check(
        &mut self,
        display: &Path,
        source: &str,
        config: &Config,
        strict: bool,
    ) -> Result<Vec<Finding>, LintError> {
        let tree = self
            .parser
            .parse(source, None)
            .ok_or_else(|| LintError::NoTree(display.to_owned()))?;
        let root = tree.root_node();

        if let Some(defect) = first_defect(root) {
            return Ok(vec![defect.finding(display)]);
        }

        let mut findings = Vec::new();
        for declaration in declarations(root, source) {
            check_declaration(&declaration, display, config, strict, &mut findings);
        }
        findings.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
        Ok(findings)
    }
}

struct Defect {
    position: Position,
    kind: String,
    missing: bool,
}

impl Defect {
    fn finding(&self, display: &Path) -> Finding {
        let message = if self.missing {
            format!("parse error: missing {}", self.kind)
        } else {
            format!("parse error: unexpected {}", self.kind)
        };
        Finding::new(display, self.position, RuleId::PARSE, message)
    }
}

/// The first `ERROR` or `MISSING` node in document order.
fn first_defect(node: Node<'_>) -> Option<Defect> {
    if node.is_error() || node.is_missing() {
        let start = node.start_position();
        return Some(Defect {
            position: Position::from_zero_based(start.row, start.column),
            kind: node.kind().to_owned(),
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
    display: &Path,
    config: &Config,
    strict: bool,
    findings: &mut Vec<Finding>,
) {
    let kind_config = config.kinds.get(declaration.kind);
    let requires_docs = match kind_config.docs {
        DocsPolicy::All => true,
        DocsPolicy::Exported => declaration.exported,
        DocsPolicy::None => false,
    };

    let Some(attached) = declaration.doc.as_ref() else {
        if requires_docs {
            findings.push(Finding::new(
                display,
                declaration.position,
                RuleId::MISSING_DOC,
                format!("{} has no doc comment", subject(declaration)),
            ));
        }
        return;
    };

    // A forbidden tag is a finding wherever it appears, documented or not.
    for forbidden in &config.tags.forbid {
        for occurrence in attached.comment.tags() {
            if &occurrence.tag == forbidden {
                findings.push(Finding::new(
                    display,
                    attached.tag_position(occurrence),
                    RuleId::FORBIDDEN_TAG,
                    format!("forbidden tag {forbidden}"),
                ));
            }
        }
    }

    if declaration.kind == DeclKind::Module {
        check_module_name(declaration, display, findings);
    }

    if !requires_docs {
        return;
    }

    for required in &kind_config.tags {
        if !attached.comment.has(required) {
            findings.push(Finding::new(
                display,
                declaration.position,
                RuleId::MISSING_TAG,
                format!("{} doc comment has no {required}", subject(declaration)),
            ));
        }
    }

    check_constraints(declaration, display, config, strict, findings);
}

/// `@module <Name>` must name the module it documents.
fn check_module_name(declaration: &Declaration, display: &Path, findings: &mut Vec<Finding>) {
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
        findings.push(Finding::new(
            display,
            attached.tag_position(occurrence),
            RuleId::MODULE_NAME,
            format!("@module names `{documented}`, but the module is `{name}`"),
        ));
    }
}

/// The documented name is the first word, without generic arguments or trailing punctuation.
fn module_name(value: &str) -> &str {
    let first = value.split_whitespace().next().unwrap_or_default();
    let without_generics = first.split('<').next().unwrap_or(first);
    without_generics.trim_end_matches(['.', ',', ':', ';'])
}

/// Exported non-pure circuits carry the constraints annotation.
fn check_constraints(
    declaration: &Declaration,
    display: &Path,
    config: &Config,
    strict: bool,
    findings: &mut Vec<Finding>,
) {
    if declaration.kind != DeclKind::Circuit || !declaration.exported || declaration.pure {
        return;
    }
    let Some(attached) = declaration.doc.as_ref() else {
        return;
    };
    let tag = &config.constraints.tag;

    let Some(occurrence) = attached.comment.first(tag) else {
        findings.push(Finding::new(
            display,
            declaration.position,
            RuleId::MISSING_CONSTRAINTS,
            format!("{} doc comment has no {tag}", subject(declaration)),
        ));
        return;
    };

    // The annotation is one line; anything below it is prose, not part of the value.
    let value = occurrence.value.lines().next().unwrap_or_default().trim();
    let position = attached.tag_position(occurrence);

    let Some(placeholders) = parse_constraints(value) else {
        findings.push(Finding::new(
            display,
            position,
            RuleId::CONSTRAINTS_FORMAT,
            format!("{tag} value `{value}` is not `k=<n>, rows=<n>`"),
        ));
        return;
    };

    if strict && placeholders {
        findings.push(Finding::new(
            display,
            position,
            RuleId::CONSTRAINTS_PLACEHOLDER,
            format!("{tag} value `{value}` still holds a placeholder"),
        ));
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
