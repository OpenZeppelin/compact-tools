//! The `fix` subcommand: turn the fixable issues into edits and rewrite the files.

use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;

use crate::config::Config;
use crate::doc::Tag;
use crate::edit::{DocOp, Edit, EditKind, apply, newline_of};
use crate::model::DeclKind;
use crate::report::Position;
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
    #[error("cannot write {path}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("refusing to write {path}: the edits would change its declarations")]
    Unsafe { path: PathBuf },
}

/// Everything the `fix` subcommand needs, already resolved from flags.
pub struct Options {
    pub paths: Vec<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub dry_run: bool,
}

/// The edits one file took.
pub struct FileEdits {
    pub path: PathBuf,
    pub edits: Vec<Edit>,
}

/// Every file the run changed, in the order they were visited.
pub struct Outcome {
    pub files: Vec<FileEdits>,
}

impl Outcome {
    #[must_use]
    pub fn edits(&self) -> usize {
        self.files.iter().map(|file| file.edits.len()).sum()
    }

    #[must_use]
    pub fn summary(&self) -> String {
        format!("{} edits in {} files", self.edits(), self.files.len())
    }
}

/// Runs the subcommand with `cwd` as the working directory.
/// # Errors
/// Returns an error when the config, the file walk, the parser or a write fails.
pub fn run(options: &Options, cwd: &Path) -> Result<Outcome, FixError> {
    let target = target::resolve(&options.paths, options.config_path.as_deref(), cwd)?;

    let mut linter = Linter::new()?;
    let mut files = Vec::new();

    for path in &target.files {
        let source = std::fs::read_to_string(path).map_err(|source| FixError::Read {
            path: path.clone(),
            source,
        })?;

        let newline = newline_of(&source);
        let issues = linter.issues(path, &source, &target.config, false)?;
        let edits: Vec<Edit> = issues
            .iter()
            .filter(|issue| !supplied_elsewhere(issue, &issues, &target.config))
            .filter_map(|issue| edit_for(issue, &target.config, newline))
            .collect();

        if edits.is_empty() {
            continue;
        }

        let fixed = apply(&source, &edits, newline);
        if changes_declarations(&mut linter, path, &source, &fixed)? {
            return Err(FixError::Unsafe { path: path.clone() });
        }
        if !options.dry_run {
            write_atomically(path, &fixed)?;
        }
        files.push(FileEdits {
            path: path.clone(),
            edits,
        });
    }

    Ok(Outcome { files })
}

/// Whether `after` parses into other declarations than `before`. Doc edits never should,
/// so a difference means an edit broke a comment delimiter.
fn changes_declarations(
    linter: &mut Linter,
    path: &Path,
    before: &str,
    after: &str,
) -> Result<bool, LintError> {
    Ok(linter.outline(path, before)? != linter.outline(path, after)?)
}

/// Whether another edit on the same doc comment already writes the tag this
/// `missing-tag` or `missing-constraints` issue would insert: a rename to it, or, for
/// the constraints tag, the constraints line.
///
/// Inserting it as well would leave the comment carrying the tag twice.
fn supplied_elsewhere(issue: &Issue, issues: &[Issue], config: &Config) -> bool {
    let (Issue::MissingTag { tag, doc, .. } | Issue::MissingConstraints { tag, doc, .. }) = issue
    else {
        return false;
    };
    let inserts_tag = matches!(issue, Issue::MissingTag { .. });

    issues.iter().any(|other| match other {
        Issue::ForbiddenTag {
            tag: forbidden,
            doc: other_doc,
            ..
        } => other_doc == doc && config.rename_of(forbidden) == Some(tag),
        Issue::MissingConstraints { doc: other_doc, .. } => {
            inserts_tag && other_doc == doc && *tag == config.constraints.tag
        }
        _ => false,
    })
}

/// The repair for one issue, or `None` where the rule has no safe fix.
///
/// `constraints-format` and `constraints-placeholder` need a measurement a rewrite
/// cannot invent, and `parse` and `format` are not doc-comment issues at all.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "a flat dispatch with one arm per rule"
)]
pub fn edit_for(issue: &Issue, config: &Config, newline: &str) -> Option<Edit> {
    match issue {
        Issue::MissingDoc {
            position,
            subject,
            kind,
            name,
            offset,
            indent,
            constraints,
        } => Some(Edit {
            position: *position,
            message: format!("inserted doc skeleton for {subject}"),
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
            position,
            kind,
            tag,
            name,
            doc,
            ..
        } => Some(Edit {
            position: *position,
            message: format!("inserted {tag}"),
            kind: EditKind::Doc {
                range: doc.range.clone(),
                indent: doc.indent,
                op: missing_tag_op(*kind, tag, name.as_deref(), config),
            },
        }),

        Issue::MissingConstraints {
            position, tag, doc, ..
        } => Some(Edit {
            position: *position,
            message: format!("inserted {tag} {UNMEASURED}"),
            kind: EditKind::Doc {
                range: doc.range.clone(),
                indent: doc.indent,
                op: DocOp::InsertConstraints(format!("{tag} {UNMEASURED}")),
            },
        }),

        Issue::UndocumentedConstraints {
            position,
            tag,
            offset,
            indent,
            ..
        } => Some(Edit {
            position: *position,
            message: format!("inserted {tag} {UNMEASURED}"),
            kind: EditKind::Insert {
                offset: *offset,
                text: doc_comment(&[format!("{tag} {UNMEASURED}")], *indent, newline),
            },
        }),

        Issue::ForbiddenTag {
            position,
            tag,
            line_offset,
            doc,
        } => {
            let replacement = config.rename_of(tag)?;
            Some(Edit {
                position: *position,
                message: format!("renamed {tag} to {replacement}"),
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
            position,
            name,
            line_offset,
            doc,
            ..
        } => Some(Edit {
            position: *position,
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
/// annotation where the declaration takes one. That annotation is the only line the
/// constraints tag gets, even when `kinds.<kind>.tags` lists it.
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
        .filter(|tag| !constraints || **tag != config.constraints.tag)
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

    doc_comment(&body, indent, newline)
}

/// Renders body lines as a `/** … */` block inserted before a declaration.
fn doc_comment(body: &[String], indent: usize, newline: &str) -> String {
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

/// How many unique names to try before giving up on the temporary file.
const TEMPORARY_ATTEMPTS: u32 = 8;

/// Writes through a sibling temporary file, so a failed write never truncates the source.
fn write_atomically(path: &Path, text: &str) -> Result<(), FixError> {
    let (temporary, mut handle) = create_temporary(path)?;

    let write = handle
        .write_all(text.as_bytes())
        .and_then(|()| handle.sync_all())
        .and_then(|()| std::fs::metadata(path))
        .and_then(|metadata| std::fs::set_permissions(&temporary, metadata.permissions()))
        .and_then(|()| std::fs::rename(&temporary, path));

    write.map_err(|source| {
        // The rename never happened, so the temporary file is ours to clean up.
        let _ = std::fs::remove_file(&temporary);
        FixError::Write {
            path: path.to_owned(),
            source,
        }
    })
}

/// Creates a sibling temporary file under a name nothing else holds.
///
/// A predictable name lets another process plant a file the write would truncate, so
/// the name carries the pid and a timestamp and the file is created exclusively.
fn create_temporary(path: &Path) -> Result<(PathBuf, File), FixError> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_name().unwrap_or(OsStr::new("source"));
    let pid = std::process::id();

    let mut last = None;
    for attempt in 0..TEMPORARY_ATTEMPTS {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.subsec_nanos());
        let mut name = OsString::from(".");
        name.push(stem);
        name.push(format!(".{pid}.{nanos}.{attempt}.tmp"));
        let candidate = directory.join(name);

        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(handle) => return Ok((candidate, handle)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => last = Some(error),
            Err(source) => {
                return Err(FixError::Write {
                    path: path.to_owned(),
                    source,
                });
            }
        }
    }

    Err(FixError::Write {
        path: path.to_owned(),
        source: last.unwrap_or_else(|| ErrorKind::AlreadyExists.into()),
    })
}

/// The line `fix` prints for one edit.
#[must_use]
pub fn line(path: &Path, position: Position, message: &str) -> String {
    format!(
        "{}:{}:{}: fix: {message}",
        path.display(),
        position.line,
        position.column
    )
}

#[cfg(test)]
mod tests {
    use super::{changes_declarations, skeleton};
    use crate::config::Config;
    use crate::doc::Tag;
    use crate::model::DeclKind;
    use crate::rules::Linter;
    use std::path::Path;

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
    fn a_required_constraints_tag_is_written_once() {
        let mut config = config();
        config.kinds.circuit.tags = vec![Tag::new("@description"), Tag::new("@constraints")];

        assert_eq!(
            skeleton(DeclKind::Circuit, Some("run"), true, &config, 0, "\n"),
            "/**\n * @description TODO\n *\n * @constraints k=?, rows=?\n */\n"
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
    fn an_unterminated_comment_counts_as_a_declaration_change() {
        let mut linter = Linter::new().expect("the bundled grammar loads");
        let path = Path::new("a.compact");
        let before = "/** @module Old */\nmodule Access {\n}\n";

        let closed = "/** @module Access */\nmodule Access {\n}\n";
        let unclosed = "/** @module Access\nmodule Access {\n}\n";
        assert!(!changes_declarations(&mut linter, path, before, closed).expect("parses"));
        assert!(changes_declarations(&mut linter, path, before, unclosed).expect("parses"));
    }

    #[test]
    fn a_crlf_skeleton_uses_the_file_line_ending() {
        assert_eq!(
            skeleton(DeclKind::Type, None, false, &config(), 0, "\r\n"),
            "/**\r\n * TODO\r\n */\r\n"
        );
    }
}
