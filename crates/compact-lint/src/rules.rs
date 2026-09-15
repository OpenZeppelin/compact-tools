//! The doc-comment rules, run over one parsed file at a time.
//!
//! Detection yields [`Issue`]s. `check` renders them as [`Diagnostic`]s and `fix` renders
//! the fixable ones as edits, so both subcommands read the same detection pass.

use std::ops::Range;
use std::path::{Path, PathBuf};

use thiserror::Error;
use tree_sitter::{Node, Parser};

use crate::config::{Config, DocsPolicy};
use crate::diagnostic::{Diagnostic, Level, Span, sentence};
use crate::doc::Tag;
use crate::model::{DeclKind, Declaration, declarations};
use crate::report::{Position, RuleId};

/// The tag whose value must name the module it documents.
const MODULE_TAG: &str = "@module";

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

/// A constraints annotation already present on an exported non-pure circuit.
///
/// `check` only reports the annotations it faults; `fill-constraints` rewrites every one
/// of them, so it reads the sites directly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConstraintSite {
    /// The circuit's name, which is the name its measurement carries.
    pub circuit: String,
    /// Position of the tag's `@`.
    pub position: Position,
    /// 0-based line index of the tag inside the doc comment.
    pub line_offset: usize,
    /// The annotation's value, first line only.
    pub value: String,
    pub doc: DocRef,
}

/// One rule violation, carrying what `check` prints and what `fix` needs to repair it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Issue {
    Parse {
        position: Position,
        end: Position,
        node_kind: String,
        missing: bool,
    },
    MissingDoc {
        position: Position,
        end: Position,
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
        end: Position,
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
        end: Position,
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

    /// The sentence a reporter prints, capitalised and closed like Biome's.
    #[must_use]
    pub fn message(&self) -> String {
        let body = match self {
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
            } => format!("{MODULE_TAG} names `{documented}`, but the module is `{name}`"),
            Self::ConstraintsFormat { tag, value, .. } => {
                format!("{tag} value `{value}` is not `k=<n>, rows=<n>`")
            }
            Self::ConstraintsPlaceholder { tag, value, .. } => {
                format!("{tag} value `{value}` still holds a placeholder")
            }
        };
        sentence(&body)
    }

    /// The one-sentence `i` line telling the reader what to do about it.
    #[must_use]
    pub fn advice(&self, config: &Config) -> String {
        match self {
            Self::Parse { .. } => {
                "Fix the syntax error; the doc rules are skipped for this file.".to_owned()
            }
            Self::MissingDoc { .. } => {
                "Add a doc comment above it, or run compact-lint fix.".to_owned()
            }
            Self::MissingTag { tag, .. } => {
                format!("Add {tag} to the doc comment, or run compact-lint fix.")
            }
            Self::ForbiddenTag { tag, .. } => match config.rename_of(tag) {
                Some(replacement) => format!("Rename it to {replacement}."),
                None => "Remove it from the doc comment.".to_owned(),
            },
            Self::ModuleName { name, .. } => {
                format!("Set the tag to {name}, or run compact-lint fix.")
            }
            Self::MissingConstraints { tag, .. } => format!(
                "Run compact-lint fill-constraints after adding the tag, or add it as {tag} k=?, rows=? to fill later."
            ),
            Self::ConstraintsFormat { .. } => "Write the value as k=<n>, rows=<n>.".to_owned(),
            Self::ConstraintsPlaceholder { .. } => {
                "Run compact-lint fill-constraints to measure it.".to_owned()
            }
        }
    }

    /// What a reporter underlines: the declaration head, or the tag token itself.
    #[must_use]
    pub fn span(&self) -> Span {
        match self {
            Self::Parse { position, end, .. }
            | Self::MissingDoc { position, end, .. }
            | Self::MissingTag { position, end, .. }
            | Self::MissingConstraints { position, end, .. } => Span::new(*position, *end),
            Self::ForbiddenTag { position, tag, .. }
            | Self::ConstraintsFormat { position, tag, .. }
            | Self::ConstraintsPlaceholder { position, tag, .. } => {
                Span::columns(*position, tag.as_str().len())
            }
            Self::ModuleName { position, .. } => Span::columns(*position, MODULE_TAG.len()),
        }
    }

    /// The diagnostic for this issue, without the fix preview the caller attaches.
    #[must_use]
    pub fn diagnostic(&self, display: &Path, level: Level, config: &Config) -> Diagnostic {
        Diagnostic::new(display, self.rule(), level, self.message())
            .at(self.span())
            .advise(self.advice(config))
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
    ) -> Result<Vec<Issue>, LintError> {
        let tree = self
            .parser
            .parse(source, None)
            .ok_or_else(|| LintError::NoTree(display.to_owned()))?;
        let root = tree.root_node();

        if let Some(defect) = first_defect(root) {
            return Ok(if config.rules.get(RuleId::PARSE) == Level::Off {
                Vec::new()
            } else {
                vec![defect]
            });
        }

        let mut issues = Vec::new();
        for declaration in declarations(root, source) {
            check_declaration(&declaration, config, &mut issues);
        }
        issues.retain(|issue| config.rules.get(issue.rule()) != Level::Off);
        issues.sort_by_key(|issue| (issue.position(), issue.rule()));
        Ok(issues)
    }

    /// Every constraints annotation in one file, in source order.
    ///
    /// A file holding a parse defect yields none, because its declarations are not
    /// trustworthy enough to rewrite.
    /// # Errors
    /// Returns an error when tree-sitter produces no tree for `source`.
    pub fn constraint_sites(
        &mut self,
        display: &Path,
        source: &str,
        config: &Config,
    ) -> Result<Vec<ConstraintSite>, LintError> {
        let tree = self
            .parser
            .parse(source, None)
            .ok_or_else(|| LintError::NoTree(display.to_owned()))?;
        let root = tree.root_node();

        if first_defect(root).is_some() {
            return Ok(Vec::new());
        }

        Ok(declarations(root, source)
            .iter()
            .filter_map(|declaration| constraint_site(declaration, &config.constraints.tag))
            .collect())
    }
}

/// The first `ERROR` or `MISSING` node in document order.
fn first_defect(node: Node<'_>) -> Option<Issue> {
    if node.is_error() || node.is_missing() {
        let start = node.start_position();
        let end = node.end_position();
        return Some(Issue::Parse {
            position: Position::from_zero_based(start.row, start.column),
            end: Position::from_zero_based(end.row, end.column),
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

fn check_declaration(declaration: &Declaration, config: &Config, issues: &mut Vec<Issue>) {
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
                end: declaration.end,
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
                end: declaration.end,
                subject: subject(declaration),
                kind: declaration.kind,
                tag: required.clone(),
                name: declaration.name.clone(),
                doc: doc.clone(),
            });
        }
    }

    check_constraints(declaration, &doc, config, issues);
}

/// `@module <Name>` must name the module it documents.
fn check_module_name(declaration: &Declaration, doc: &DocRef, issues: &mut Vec<Issue>) {
    let tag = Tag::new(MODULE_TAG);
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

/// The annotation on one declaration, where it is a named circuit that takes one.
fn constraint_site(declaration: &Declaration, tag: &Tag) -> Option<ConstraintSite> {
    if !takes_constraints(declaration) {
        return None;
    }
    let attached = declaration.doc.as_ref()?;
    let occurrence = attached.comment.first(tag)?;

    Some(ConstraintSite {
        circuit: declaration.name.clone()?,
        position: attached.tag_position(occurrence),
        line_offset: occurrence.line_offset,
        value: value_of(occurrence).to_owned(),
        doc: DocRef {
            range: attached.range.clone(),
            indent: attached.start_column,
        },
    })
}

fn check_constraints(
    declaration: &Declaration,
    doc: &DocRef,
    config: &Config,
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
            end: declaration.end,
            subject: subject(declaration),
            tag: tag.clone(),
            doc: doc.clone(),
        });
        return;
    };

    let value = value_of(occurrence);
    let position = attached.tag_position(occurrence);

    let Some(placeholders) = parse_constraints(value) else {
        issues.push(Issue::ConstraintsFormat {
            position,
            tag: tag.clone(),
            value: value.to_owned(),
        });
        return;
    };

    if placeholders {
        issues.push(Issue::ConstraintsPlaceholder {
            position,
            tag: tag.clone(),
            value: value.to_owned(),
        });
    }
}

/// The annotation is one line; anything below it is prose, not part of the value.
fn value_of(occurrence: &crate::doc::TagOccurrence) -> &str {
    occurrence.value.lines().next().unwrap_or_default().trim()
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
    use crate::diagnostic::Level;
    use crate::diagnostic::sentence;
    use crate::doc::Tag;
    use crate::report::RuleId;
    use std::path::Path;

    /// One `line:col rule message` line per issue, the fields every reporter starts from.
    fn reported(source: &str, config: &Config) -> Vec<String> {
        Linter::new()
            .expect("the bundled grammar loads")
            .issues(Path::new("a.compact"), source, config)
            .expect("the source produced a tree")
            .iter()
            .map(|issue| {
                let span = issue.span();
                format!(
                    "{}:{} {} {}",
                    span.start.line,
                    span.start.column,
                    issue.rule(),
                    issue.message()
                )
            })
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

        assert!(reported(source, &Config::default()).is_empty());
    }

    #[test]
    fn an_exported_module_without_a_doc_comment_is_reported() {
        let source = "export module M {\n}\n";

        assert_eq!(
            reported(source, &Config::default()),
            ["1:1 missing-doc Module `M` has no doc comment."]
        );
    }

    #[test]
    fn a_line_comment_between_the_doc_and_the_declaration_breaks_attachment() {
        let source = "/** @description M. */\n// a note\nexport module M {\n}\n";

        assert_eq!(
            reported(source, &Config::default()),
            ["3:1 missing-doc Module `M` has no doc comment."]
        );
    }

    #[test]
    fn a_pure_exported_circuit_needs_no_constraints() {
        let source = "/** @description Adds. */\nexport pure circuit add(a: Uint<8>): Uint<8> { return a; }\n";

        assert!(reported(source, &circuit_config()).is_empty());
    }

    #[test]
    fn an_exported_circuit_without_constraints_is_reported() {
        let source =
            "/** @description Bumps. */\nexport circuit bump(): [] { count.increment(1); }\n";

        assert_eq!(
            reported(source, &circuit_config()),
            ["2:1 missing-constraints Circuit `bump` doc comment has no @constraints."]
        );
    }

    #[test]
    fn a_declaration_span_ends_at_its_name() {
        let source = "export module M {\n}\n";
        let issues = Linter::new()
            .expect("the bundled grammar loads")
            .issues(Path::new("a.compact"), source, &Config::default())
            .expect("the source produced a tree");

        assert_eq!(issues[0].span().end.column, "export module M".len() + 1);
    }

    #[test]
    fn a_tag_span_covers_the_tag_token() {
        let source = "/**\n * @return nothing\n */\ncircuit hidden(): [] { }\n";
        let mut config = Config::default();
        config.tags.forbid = vec![Tag::new("@return")];

        let issues = Linter::new()
            .expect("the bundled grammar loads")
            .issues(Path::new("a.compact"), source, &config)
            .expect("the source produced a tree");
        let span = issues[0].span();

        assert_eq!(span.start.column, 4);
        assert_eq!(span.end.column, 11);
    }

    #[test]
    fn a_placeholder_is_reported_without_strict_too() {
        let source = "/**\n * @description Bumps.\n * @constraints k=?, rows=?\n */\nexport circuit bump(): [] { }\n";

        assert_eq!(
            reported(source, &circuit_config()),
            [
                "3:4 constraints-placeholder @constraints value `k=?, rows=?` still holds a placeholder."
            ]
        );
    }

    #[test]
    fn a_rule_set_to_off_produces_no_issue() {
        let source = "export module M {\n}\n";
        let mut config = Config::default();
        config.rules.missing_doc = Level::Off;

        assert!(reported(source, &config).is_empty());
    }

    #[test]
    fn a_forbidden_tag_is_reported_even_where_docs_are_optional() {
        let source = "/**\n * @return nothing\n */\ncircuit hidden(): [] { }\n";
        let mut config = Config::default();
        config.tags.forbid = vec![Tag::new("@return")];

        assert_eq!(
            reported(source, &config),
            ["2:4 forbidden-tag Forbidden tag @return."]
        );
    }

    #[test]
    fn a_rename_becomes_the_advice_for_a_forbidden_tag() {
        let source = "/**\n * @return nothing\n */\ncircuit hidden(): [] { }\n";
        let mut config = Config::default();
        config.tags.forbid = vec![Tag::new("@return")];
        config
            .tags
            .rename
            .insert(Tag::new("@return"), Tag::new("@returns"));

        let issues = Linter::new()
            .expect("the bundled grammar loads")
            .issues(Path::new("a.compact"), source, &config)
            .expect("the source produced a tree");

        assert_eq!(issues[0].advice(&config), "Rename it to @returns.");
    }

    #[test]
    fn a_witness_under_docs_all_is_checked_without_export() {
        let source = "witness wit_secret(): Bytes<32>;\n";
        let mut config = Config::default();
        config.kinds.witness.docs = DocsPolicy::All;

        assert_eq!(
            reported(source, &config),
            ["1:1 missing-doc Witness `wit_secret` has no doc comment."]
        );
    }

    #[test]
    fn a_parse_defect_suppresses_the_doc_rules() {
        let source = "export module M {\nexport circuit\n";

        let issues = reported(source, &Config::default());
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].contains("Parse error"), "{issues:?}");
    }

    #[test]
    fn parse_set_to_off_leaves_a_broken_file_silent() {
        let source = "export module M {\nexport circuit\n";
        let mut config = Config::default();
        config.rules.parse = Level::Off;

        assert!(reported(source, &config).is_empty());
    }

    #[test]
    fn the_constraints_tag_is_configurable() {
        let source = "/**\n * @description Bumps.\n * @circuitInfo k=6, rows=28\n */\nexport circuit bump(): [] { }\n";
        let mut config = circuit_config();
        config.constraints.tag = Tag::new("@circuitInfo");

        assert!(reported(source, &config).is_empty());
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

    #[test]
    fn a_message_opens_with_a_capital_and_closes_with_one_period() {
        assert_eq!(sentence("forbidden tag @return"), "Forbidden tag @return.");
        assert_eq!(sentence("@module names `A`."), "@module names `A`.");
    }

    #[test]
    fn every_configurable_rule_has_a_level() {
        let rules = Config::default().rules;

        assert!(
            RuleId::ALL
                .iter()
                .all(|rule| rules.get(*rule) != Level::Info)
        );
    }
}
