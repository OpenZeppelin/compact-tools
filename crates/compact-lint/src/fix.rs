//! The `fix` subcommand: turn the fixable issues into edits and rewrite the files.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::Config;
use crate::diagnostic::{Badge, Diagnostic, FixPreview, Level, capitalise};
use crate::doc::Tag;
use crate::edit::{DocOp, Edit, EditKind, WriteError, apply, newline_of, write_atomically};
use crate::model::DeclKind;
use crate::report::RuleId;
use crate::rules::{Issue, LintError, Linter};
use crate::target::{self, TargetError};

/// The value written into an inserted constraints annotation.
const UNMEASURED: &str = "k=?, rows=?";

/// The tag whose value is the declaration's own name.
const MODULE_TAG: &str = "@module";

/// The tag that adopts untagged prose opening a doc comment.
const DESCRIPTION_TAG: &str = "@description";

#[derive(Debug, Error)]
pub enum FixError {
    #[error(transparent)]
    Target(#[from] TargetError),
    #[error(transparent)]
    Lint(#[from] LintError),
    #[error("cannot read {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Write(#[from] WriteError),
}

/// Everything the `fix` subcommand needs, already resolved from flags.
pub struct Options {
    pub paths: Vec<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub dry_run: bool,
}

/// What the run changed, and the diagnostic for every edit.
pub struct Outcome {
    pub diagnostics: Vec<Diagnostic>,
    /// Files the run visited, changed or not.
    pub checked: usize,
    /// Files that took at least one edit.
    pub changed: usize,
}

impl Outcome {
    #[must_use]
    pub fn edits(&self) -> usize {
        self.diagnostics.len()
    }
}

/// Runs the subcommand with `cwd` as the working directory.
/// # Errors
/// Returns an error when the config, the file walk, the parser or a write fails.
pub fn run(options: &Options, cwd: &Path) -> Result<Outcome, FixError> {
    let target = target::resolve(&options.paths, options.config_path.as_deref(), cwd)?;

    let badge = if options.dry_run {
        Badge::Fixable
    } else {
        Badge::Fixed
    };

    let mut linter = Linter::new()?;
    let mut diagnostics = Vec::new();
    let mut changed = 0;

    for path in &target.files {
        let source = std::fs::read_to_string(path).map_err(|source| FixError::Read {
            path: path.clone(),
            source,
        })?;

        let newline = newline_of(&source);
        let issues = linter.issues(path, &source, &target.config)?;
        let repairs: Vec<(&Issue, Edit)> = issues
            .iter()
            .filter_map(|issue| edit_for(issue, &target.config, newline).map(|edit| (issue, edit)))
            .collect();

        if repairs.is_empty() {
            continue;
        }

        for (issue, edit) in &repairs {
            diagnostics.push(diagnostic(path, issue, edit, &source, newline, badge));
        }

        let edits: Vec<Edit> = repairs.into_iter().map(|(_, edit)| edit).collect();
        if !options.dry_run {
            write_atomically(path, &apply(&source, &edits, newline))?;
        }
        changed += 1;
    }

    Ok(Outcome {
        diagnostics,
        checked: target.files.len(),
        changed,
    })
}

/// The `i` line above a fix diff: what it does, and whether it is already done.
///
/// An offered fix that writes a placeholder is `Unsafe`, the way Biome marks a fix the
/// reader still has to finish.
#[must_use]
pub fn title(edit: &Edit, badge: Badge) -> String {
    let what = capitalise(&edit.message);
    match badge {
        Badge::Fixed => format!("Applied fix: {what}"),
        Badge::Fixable if edit.kind.is_safe() => format!("Safe fix: {what}"),
        Badge::Fixable => format!("Unsafe fix: {what}"),
    }
}

/// One repair as a diagnostic: the issue states the problem, the title states the fix.
fn diagnostic(
    path: &Path,
    issue: &Issue,
    edit: &Edit,
    source: &str,
    newline: &str,
    badge: Badge,
) -> Diagnostic {
    let after = apply(source, std::slice::from_ref(edit), newline);

    Diagnostic::new(path, edit.rule, Level::Info, issue.message())
        .at(edit.span)
        .fixed_by(
            FixPreview::between(title(edit, badge), source, &after),
            badge,
        )
}

/// The repair for one issue, or `None` where the rule has no safe fix.
///
/// `constraints-format` and `constraints-placeholder` need a measurement a rewrite
/// cannot invent, and `parse` and `format` are not doc-comment issues at all.
#[must_use]
pub fn edit_for(issue: &Issue, config: &Config, newline: &str) -> Option<Edit> {
    let span = issue.span();
    match issue {
        Issue::MissingDoc {
            subject,
            kind,
            name,
            offset,
            indent,
            constraints,
            ..
        } => Some(Edit {
            span,
            rule: RuleId::MISSING_DOC,
            message: format!("insert a doc skeleton for {subject}"),
            kind: EditKind::Insert {
                offset: *offset,
                text: skeleton(
                    *kind,
                    name.as_deref(),
                    *constraints,
                    config,
                    *indent,
                    newline,
                ),
            },
        }),

        Issue::MissingTag {
            kind,
            tag,
            name,
            doc,
            ..
        } => Some(Edit {
            span,
            rule: RuleId::MISSING_TAG,
            message: format!("insert {tag}"),
            kind: EditKind::Doc {
                range: doc.range.clone(),
                indent: doc.indent,
                op: missing_tag_op(*kind, tag, name.as_deref(), config),
            },
        }),

        Issue::MissingConstraints { tag, doc, .. } => Some(Edit {
            span,
            rule: RuleId::MISSING_CONSTRAINTS,
            message: format!("insert {tag} {UNMEASURED}"),
            kind: EditKind::Doc {
                range: doc.range.clone(),
                indent: doc.indent,
                op: DocOp::InsertConstraints(format!("{tag} {UNMEASURED}")),
            },
        }),

        Issue::ForbiddenTag {
            tag,
            line_offset,
            doc,
            ..
        } => {
            let replacement = config.rename_of(tag)?;
            Some(Edit {
                span,
                rule: RuleId::FORBIDDEN_TAG,
                message: format!("rename {tag} to {replacement}"),
                kind: EditKind::Doc {
                    range: doc.range.clone(),
                    indent: doc.indent,
                    op: DocOp::RenameTag {
                        line: *line_offset,
                        from: tag.to_string(),
                        to: replacement.to_string(),
                    },
                },
            })
        }

        Issue::ModuleName {
            name,
            line_offset,
            doc,
            ..
        } => Some(Edit {
            span,
            rule: RuleId::MODULE_NAME,
            message: format!("set {MODULE_TAG} to `{name}`"),
            kind: EditKind::Doc {
                range: doc.range.clone(),
                indent: doc.indent,
                op: DocOp::SetModuleName {
                    line: *line_offset,
                    name: name.clone(),
                },
            },
        }),

        Issue::Parse { .. }
        | Issue::ConstraintsFormat { .. }
        | Issue::ConstraintsPlaceholder { .. } => None,
    }
}

/// The tag line lands after the tags that precede it in config order; `@description`
/// adopts prose that opens the body.
fn missing_tag_op(kind: DeclKind, tag: &Tag, name: Option<&str>, config: &Config) -> DocOp {
    DocOp::InsertTag {
        line: tag_line(tag, name, config),
        after: config
            .kinds
            .get(kind)
            .tags
            .iter()
            .take_while(|required| *required != tag)
            .map(ToString::to_string)
            .collect(),
        adopts_prose: tag.as_str() == DESCRIPTION_TAG,
    }
}

/// `@module` takes the declaration's own name; every other tag takes the placeholder.
fn tag_line(tag: &Tag, name: Option<&str>, config: &Config) -> String {
    match name {
        Some(name) if tag.as_str() == MODULE_TAG => format!("{tag} {name}"),
        _ => format!("{tag} {}", config.fix.placeholder),
    }
}

/// The doc comment `fix` writes above an undocumented declaration.
///
/// Body lines come from `kinds.<kind>.tags` in config order, then the constraints
/// annotation where the declaration takes one.
fn skeleton(
    kind: DeclKind,
    name: Option<&str>,
    constraints: bool,
    config: &Config,
    indent: usize,
    newline: &str,
) -> String {
    let mut body: Vec<String> = config
        .kinds
        .get(kind)
        .tags
        .iter()
        .map(|tag| tag_line(tag, name, config))
        .collect();

    if constraints {
        if !body.is_empty() {
            body.push(String::new());
        }
        body.push(format!("{} {UNMEASURED}", config.constraints.tag));
    }
    if body.is_empty() {
        body.push(config.fix.placeholder.clone());
    }

    let margin = " ".repeat(indent);
    let mut lines = vec!["/**".to_owned()];
    for line in body {
        if line.is_empty() {
            lines.push(format!("{margin} *"));
        } else {
            lines.push(format!("{margin} * {line}"));
        }
    }
    lines.push(format!("{margin} */"));

    // The declaration follows on its own line, back at its original indentation.
    format!("{}{newline}{margin}", lines.join(newline))
}

#[cfg(test)]
mod tests {
    use super::skeleton;
    use crate::config::Config;
    use crate::doc::Tag;
    use crate::model::DeclKind;

    fn config() -> Config {
        let mut config = Config::default();
        config.kinds.module.tags = vec![Tag::new("@module"), Tag::new("@description")];
        config.kinds.circuit.tags = vec![Tag::new("@description")];
        config
    }

    #[test]
    fn a_module_skeleton_names_the_module() {
        assert_eq!(
            skeleton(DeclKind::Module, Some("Ownable"), false, &config(), 0, "\n"),
            "/**\n * @module Ownable\n * @description TODO\n */\n"
        );
    }

    #[test]
    fn an_exported_circuit_skeleton_carries_the_constraints_line() {
        assert_eq!(
            skeleton(DeclKind::Circuit, Some("run"), true, &config(), 2, "\n"),
            "/**\n   * @description TODO\n   *\n   * @constraints k=?, rows=?\n   */\n  "
        );
    }

    #[test]
    fn a_pure_circuit_skeleton_stops_at_the_tag_lines() {
        assert_eq!(
            skeleton(DeclKind::Circuit, Some("double"), false, &config(), 2, "\n"),
            "/**\n   * @description TODO\n   */\n  "
        );
    }

    #[test]
    fn a_kind_with_no_required_tags_still_gets_a_placeholder_body() {
        assert_eq!(
            skeleton(DeclKind::Type, Some("RoleId"), false, &config(), 2, "\n"),
            "/**\n   * TODO\n   */\n  "
        );
    }

    #[test]
    fn a_crlf_skeleton_uses_the_file_line_ending() {
        assert_eq!(
            skeleton(DeclKind::Type, None, false, &config(), 0, "\r\n"),
            "/**\r\n * TODO\r\n */\r\n"
        );
    }
}
