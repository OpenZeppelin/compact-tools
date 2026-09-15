//! Byte-range edits and the doc-comment rewriting `fix` applies.
//!
//! Every edit is computed against the original text. They are applied from the highest
//! offset down, so positions never shift, and edits that target the same doc comment are
//! merged into one replacement of that comment.

use std::ops::Range;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::diagnostic::Span;
use crate::doc::{Tag, TagSpec};
use crate::report::RuleId;

/// The tag the constraints annotation anchors itself on.
const DESCRIPTION_TAG: &str = "@description";

/// One repair, carrying the rule it answers and the span its diagnostic underlines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub span: Span,
    pub rule: RuleId,
    pub message: String,
    pub kind: EditKind,
}

/// What an edit rewrites.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditKind {
    /// Text inserted at a byte offset, used for a whole doc-comment skeleton.
    Insert { offset: usize, text: String },
    /// One rewrite of the doc comment spanning `range`.
    Doc {
        range: Range<usize>,
        /// Column the `/**` starts on, the indentation of every line the op writes.
        indent: usize,
        op: DocOp,
    },
}

impl EditKind {
    /// Whether the rewrite needs no follow-up.
    ///
    /// An edit that writes a value the tool already knows is safe; one that writes a
    /// placeholder for a human to replace is not.
    #[must_use]
    pub const fn is_safe(&self) -> bool {
        match self {
            Self::Insert { .. } => false,
            Self::Doc { op, .. } => op.is_safe(),
        }
    }
}

/// One change to the lines of a doc comment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocOp {
    /// A tag block added after the last of `after` present, else at the top of the body.
    InsertTag {
        /// The block's lines: a `@tag value` line, plus a placeholder line for a section.
        lines: Vec<String>,
        /// Entries that precede this one in config order.
        after: Vec<TagSpec>,
        /// Untagged prose opening the body becomes this tag's value instead of the placeholder.
        adopts_prose: bool,
    },
    /// A `@tag k=?, rows=?` line added after the `@description` block.
    InsertConstraints(String),
    /// The tag name on one line replaced in place.
    RenameTag {
        /// 0-based line index inside the original comment.
        line: usize,
        from: String,
        to: String,
    },
    /// The first word of `@module`'s value replaced with the module's name.
    SetModuleName {
        /// 0-based line index inside the original comment.
        line: usize,
        name: String,
    },
    /// Everything after a tag on one line replaced with a new value.
    SetTagValue {
        /// 0-based line index inside the original comment.
        line: usize,
        tag: String,
        value: String,
    },
    /// The tag blocks that match a listed entry, written back into their slots in config
    /// order.
    ReorderBlocks {
        /// The template, required entries first, in the order it lists them.
        entries: Vec<TagSpec>,
    },
}

impl DocOp {
    /// Whether the rewrite needs no follow-up; see [`EditKind::is_safe`].
    #[must_use]
    pub const fn is_safe(&self) -> bool {
        match self {
            Self::RenameTag { .. }
            | Self::SetModuleName { .. }
            | Self::SetTagValue { .. }
            | Self::ReorderBlocks { .. } => true,
            Self::InsertTag { .. } | Self::InsertConstraints(_) => false,
        }
    }
}

#[derive(Debug, Error)]
pub enum WriteError {
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
}

/// Writes through a sibling temporary file, so a failed write never truncates the source.
/// # Errors
/// Returns an error when the temporary file, the source's mode, or the rename fails.
pub fn write_atomically(path: &Path, text: &str) -> Result<(), WriteError> {
    let temporary = path.with_extension("compact.tmp");

    std::fs::write(&temporary, text).map_err(|source| WriteError::Write {
        path: temporary.clone(),
        source,
    })?;
    let permissions = std::fs::metadata(path)
        .map_err(|source| WriteError::Read {
            path: path.to_owned(),
            source,
        })?
        .permissions();
    std::fs::set_permissions(&temporary, permissions).map_err(|source| WriteError::Write {
        path: temporary.clone(),
        source,
    })?;
    std::fs::rename(&temporary, path).map_err(|source| WriteError::Write {
        path: path.to_owned(),
        source,
    })
}

/// The line ending the file already uses, taken from its first line.
#[must_use]
pub fn newline_of(source: &str) -> &'static str {
    match source.find('\n') {
        Some(index) if index > 0 && source.as_bytes()[index - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

/// Rewrites `source` with every edit, merging the edits that share a doc comment.
#[must_use]
pub fn apply(source: &str, edits: &[Edit], newline: &str) -> String {
    let mut replacements: Vec<(Range<usize>, String)> = Vec::new();
    let mut docs: Vec<(Range<usize>, usize, Vec<&DocOp>)> = Vec::new();

    for edit in edits {
        match &edit.kind {
            EditKind::Insert { offset, text } => {
                replacements.push((*offset..*offset, text.clone()));
            }
            EditKind::Doc { range, indent, op } => {
                match docs.iter_mut().find(|(known, _, _)| known == range) {
                    Some((_, _, ops)) => ops.push(op),
                    None => docs.push((range.clone(), *indent, vec![op])),
                }
            }
        }
    }

    for (range, indent, ops) in docs {
        let original = source.get(range.clone()).unwrap_or_default();
        replacements.push((range, render_doc(original, indent, newline, &ops)));
    }

    replacements.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));

    let mut out = source.to_owned();
    for (range, text) in replacements {
        if range.end <= out.len() {
            out.replace_range(range, &text);
        }
    }
    out
}

/// Applies every op to one doc comment and renders it back with `newline`.
#[must_use]
fn render_doc(doc: &str, indent: usize, newline: &str, ops: &[&DocOp]) -> String {
    let mut lines: Vec<String> = doc
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect();

    let margin = " ".repeat(indent);
    let gutter = format!("{margin} * ");

    // An insertion needs a body, so a `/** … */` one-liner expands first.
    let expands = lines.len() == 1
        && ops
            .iter()
            .any(|op| matches!(op, DocOp::InsertTag { .. } | DocOp::InsertConstraints(_)));
    let shift = usize::from(expands);
    if expands {
        lines = expand(&lines[0], &margin, &gutter);
    }

    // In-place ops address the original lines, so they run before any insertion moves
    // them; tags precede the constraints line, which anchors itself on `@description`.
    for op in ops {
        match op {
            DocOp::RenameTag { line, from, to } => {
                if let Some(target) = lines.get_mut(line + shift)
                    && let Some(renamed) = rename_tag(target, from, to)
                {
                    *target = renamed;
                }
            }
            DocOp::SetModuleName { line, name } => {
                if let Some(target) = lines.get_mut(line + shift)
                    && let Some(renamed) = set_module_name(target, name)
                {
                    *target = renamed;
                }
            }
            DocOp::SetTagValue { line, tag, value } => {
                if let Some(target) = lines.get_mut(line + shift)
                    && let Some(rewritten) = set_tag_value(target, tag, value)
                {
                    *target = rewritten;
                }
            }
            _ => {}
        }
    }

    for op in ops {
        if let DocOp::InsertTag {
            lines: inserted,
            after,
            adopts_prose,
        } = op
        {
            insert_tag(&mut lines, &gutter, inserted, after, *adopts_prose);
        }
    }

    for op in ops {
        if let DocOp::InsertConstraints(body) = op {
            insert_constraints(&mut lines, &margin, &gutter, body);
        }
    }

    // The order the template wants is decided on the finished comment, so a reorder runs
    // over the lines every other op already wrote.
    for op in ops {
        if let DocOp::ReorderBlocks { entries } = op {
            reorder_blocks(&mut lines, entries);
        }
    }

    lines.join(newline)
}

/// Splits `/** text */` into the three-line form, keeping the comment's indentation.
fn expand(single: &str, margin: &str, gutter: &str) -> Vec<String> {
    let inner = single
        .strip_prefix("/**")
        .and_then(|rest| rest.strip_suffix("*/"))
        .unwrap_or(single)
        .trim();

    vec![
        "/**".to_owned(),
        format!("{gutter}{inner}"),
        format!("{margin} */"),
    ]
}

/// A tag block lands after the block of the last entry in `after` that is present, else at
/// the top of the body. With `adopts_prose`, untagged prose opening the body takes the
/// tag instead of a new line going in.
fn insert_tag(
    lines: &mut Vec<String>,
    gutter: &str,
    inserted: &[String],
    after: &[TagSpec],
    adopts_prose: bool,
) {
    let closer = lines.len().saturating_sub(1);

    if adopts_prose
        && let Some(first) = (1..closer).find(|index| !is_blank(&lines[*index]))
        && !starts_tag(content(&lines[first]))
        && let Some((tag, _)) = inserted.first().and_then(|line| line.split_once(' '))
    {
        lines[first] = format!("{gutter}{tag} {}", content(&lines[first]));
        return;
    }

    let at = tag_block_end(lines, closer, after).map_or(1.min(closer), |end| end + 1);
    for (offset, line) in inserted.iter().enumerate() {
        lines.insert(at + offset, format!("{gutter}{line}"));
    }
}

/// Blocks matching a listed entry are written back into their slots in config order.
/// Prose before the first tag, blocks no entry lists, and the blank lines separating the
/// slots all stay where they are.
fn reorder_blocks(lines: &mut Vec<String>, entries: &[TagSpec]) {
    let closer = lines.len().saturating_sub(1);
    if closer < 2 {
        return;
    }

    let prose_end = (1..closer)
        .find(|index| starts_tag(content(&lines[*index])))
        .unwrap_or(closer);

    // A block runs from its tag line over its continuations; the blank lines under it
    // separate slots rather than belonging to what fills one.
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut separators: Vec<Vec<String>> = Vec::new();
    for line in lines.iter().take(closer).skip(prose_end) {
        if starts_tag(content(line)) {
            blocks.push(Vec::new());
            separators.push(Vec::new());
        }
        match separators.last_mut() {
            Some(separator) if is_blank(line) => separator.push(line.clone()),
            _ => {
                if let (Some(block), Some(separator)) = (blocks.last_mut(), separators.last_mut()) {
                    block.append(separator);
                    block.push(line.clone());
                }
            }
        }
    }

    let mut slots: Vec<usize> = Vec::new();
    let mut listed: Vec<(usize, Vec<String>)> = Vec::new();
    for (slot, block) in blocks.iter().enumerate() {
        let position = block.first().and_then(|line| {
            entries
                .iter()
                .position(|entry| entry.matches_line(content(line)))
        });
        if let Some(position) = position {
            slots.push(slot);
            listed.push((position, block.clone()));
        }
    }
    listed.sort_by_key(|(position, _)| *position);

    for (slot, (_, block)) in slots.iter().zip(listed) {
        blocks[*slot] = block;
    }

    let mut rebuilt: Vec<String> = lines[..prose_end].to_vec();
    for (block, separator) in blocks.into_iter().zip(separators) {
        rebuilt.extend(block);
        rebuilt.extend(separator);
    }
    rebuilt.extend_from_slice(&lines[closer..]);
    *lines = rebuilt;
}

/// The constraints line follows the `@description` block, or opens the body without one.
fn insert_constraints(lines: &mut Vec<String>, margin: &str, gutter: &str, body: &str) {
    let closer = lines.len().saturating_sub(1);
    let blank = format!("{margin} *");

    let at = match description_end(lines, closer) {
        Some(end) => {
            lines.insert(end + 1, blank.clone());
            end + 2
        }
        None => 1.min(closer),
    };

    lines.insert(at, format!("{gutter}{body}"));

    let follows = at + 1;
    if follows < lines.len() && follows != lines.len() - 1 && !is_blank(&lines[follows]) {
        lines.insert(follows, blank);
    }
}

/// The last line of the `@description` block: its tag line plus every continuation.
fn description_end(lines: &[String], closer: usize) -> Option<usize> {
    tag_block_end(lines, closer, &[TagSpec::bare(Tag::new(DESCRIPTION_TAG))])
}

/// The last line of the block opened by the last occurrence of any entry in `entries`.
fn tag_block_end(lines: &[String], closer: usize, entries: &[TagSpec]) -> Option<usize> {
    let start = (1..closer).rev().find(|index| {
        let text = content(&lines[*index]);
        entries.iter().any(|entry| entry.matches_line(text))
    })?;

    let mut end = start;
    while end + 1 < closer {
        let next = content(&lines[end + 1]);
        if next.is_empty() || starts_tag(next) {
            break;
        }
        end += 1;
    }
    Some(end)
}

/// A comment line without its indentation, its `*` and the space after it.
fn content(line: &str) -> &str {
    let trimmed = line.trim_start();
    match trimmed.strip_prefix('*') {
        Some(rest) => rest.trim(),
        None => trimmed.trim(),
    }
}

fn is_blank(line: &str) -> bool {
    content(line).is_empty()
}

fn starts_tag(content: &str) -> bool {
    content
        .strip_prefix('@')
        .is_some_and(|rest| rest.starts_with(|character: char| character.is_ascii_alphabetic()))
}

/// Replaces the first whole-word occurrence of `from`, so `@return` never claims `@returns`.
fn rename_tag(line: &str, from: &str, to: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut search = 0;
    while let Some(offset) = line.get(search..)?.find(from) {
        let start = search + offset;
        let end = start + from.len();
        let before_is_word = start > 0 && bytes[start - 1].is_ascii_alphanumeric();
        let after_is_word = bytes.get(end).is_some_and(u8::is_ascii_alphabetic);
        if !before_is_word && !after_is_word {
            return Some(format!("{}{to}{}", &line[..start], &line[end..]));
        }
        search = end;
    }
    None
}

/// Replaces everything after the tag, keeping a one-line comment's closing delimiter.
fn set_tag_value(line: &str, tag: &str, value: &str) -> Option<String> {
    let start = line.find(tag)?;
    let rest = line.get(start + tag.len()..)?;
    if rest.starts_with(|character: char| character.is_ascii_alphabetic()) {
        return None;
    }

    let closer = if rest.trim_end().ends_with("*/") {
        " */"
    } else {
        ""
    };
    Some(format!("{}{tag} {value}{closer}", &line[..start]))
}

/// Replaces the first word after `@module`, keeping whatever follows it.
fn set_module_name(line: &str, name: &str) -> Option<String> {
    let tag = "@module";
    let start = line.find(tag)?;
    let after = start + tag.len();
    let rest = line.get(after..)?;

    let spaces = rest.len() - rest.trim_start().len();
    let value = rest.trim_start();
    let word = value
        .find(char::is_whitespace)
        .map_or(value.len(), |index| index);

    if value.is_empty() {
        return Some(format!("{line} {name}"));
    }
    Some(format!(
        "{}{}{name}{}",
        &line[..after],
        &rest[..spaces],
        &value[word..]
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        DocOp, Edit, EditKind, apply, newline_of, rename_tag, render_doc, set_module_name,
        set_tag_value,
    };
    use crate::diagnostic::Span;
    use crate::doc::TagSpec;
    use crate::report::{Position, RuleId};

    fn doc_edit(range: std::ops::Range<usize>, indent: usize, op: DocOp) -> Edit {
        Edit {
            span: Span::columns(Position::file_start(), 1),
            rule: RuleId::MISSING_TAG,
            message: String::new(),
            kind: EditKind::Doc { range, indent, op },
        }
    }

    fn tag(line: &str, after: &[&str]) -> DocOp {
        DocOp::InsertTag {
            lines: vec![line.to_owned()],
            after: after.iter().map(|entry| TagSpec::parse(entry)).collect(),
            adopts_prose: line.starts_with("@description"),
        }
    }

    fn section(heading: &str, after: &[&str]) -> DocOp {
        DocOp::InsertTag {
            lines: vec![format!("{heading}:"), "TODO".to_owned()],
            after: after.iter().map(|entry| TagSpec::parse(entry)).collect(),
            adopts_prose: false,
        }
    }

    fn reorder(entries: &[&str]) -> DocOp {
        DocOp::ReorderBlocks {
            entries: entries.iter().map(|entry| TagSpec::parse(entry)).collect(),
        }
    }

    fn rendered(doc: &str, indent: usize, ops: &[DocOp]) -> String {
        let borrowed: Vec<&DocOp> = ops.iter().collect();
        render_doc(doc, indent, "\n", &borrowed)
    }

    #[test]
    fn only_the_rewrites_that_write_a_known_value_are_safe() {
        assert!(
            DocOp::RenameTag {
                line: 1,
                from: "@return".to_owned(),
                to: "@returns".to_owned(),
            }
            .is_safe()
        );
        assert!(
            DocOp::SetModuleName {
                line: 1,
                name: "Renamed".to_owned(),
            }
            .is_safe()
        );
        assert!(
            DocOp::SetTagValue {
                line: 1,
                tag: "@constraints".to_owned(),
                value: "k=7, rows=74".to_owned(),
            }
            .is_safe()
        );

        assert!(!tag("@description TODO", &[]).is_safe());
        assert!(!DocOp::InsertConstraints("@constraints k=?, rows=?".to_owned()).is_safe());
        assert!(
            !EditKind::Insert {
                offset: 0,
                text: "/**\n * TODO\n */\n".to_owned(),
            }
            .is_safe()
        );
    }

    #[test]
    fn a_tag_goes_in_at_the_top_of_the_body() {
        let doc = "/**\n   * @constraints k=6, rows=28\n   */";

        assert_eq!(
            rendered(doc, 2, &[tag("@description TODO", &[])]),
            "/**\n   * @description TODO\n   * @constraints k=6, rows=28\n   */"
        );
    }

    #[test]
    fn several_tags_keep_the_order_they_were_produced_in() {
        let doc = "/**\n * @notice loose\n */";
        let ops = [
            tag("@module Ownable", &[]),
            tag("@description TODO", &["@module"]),
        ];

        assert_eq!(
            rendered(doc, 0, &ops),
            "/**\n * @module Ownable\n * @description TODO\n * @notice loose\n */"
        );
    }

    #[test]
    fn a_tag_lands_after_the_tags_that_precede_it_in_config_order() {
        let doc = "/**\n * @module Ownable\n * spanning two lines\n *\n * @notice loose\n */";

        assert_eq!(
            rendered(doc, 0, &[tag("@description TODO", &["@module"])]),
            "/**\n * @module Ownable\n * spanning two lines\n * @description TODO\n *\n * @notice loose\n */"
        );
    }

    #[test]
    fn a_description_adopts_the_prose_that_opens_the_body() {
        let doc = "/**\n * Approved accounts.\n * @param {T} a - A.\n */";

        assert_eq!(
            rendered(doc, 0, &[tag("@description TODO", &[])]),
            "/**\n * @description Approved accounts.\n * @param {T} a - A.\n */"
        );
        assert_eq!(
            rendered(
                "/** Approved accounts. */",
                2,
                &[tag("@description TODO", &[])]
            ),
            "/**\n   * @description Approved accounts.\n   */"
        );
    }

    #[test]
    fn a_section_goes_in_as_a_heading_line_and_a_placeholder_under_it() {
        let doc = "/**\n * @notice Privacy:\n * - Amounts stay private.\n * @dev Notation:\n * - `H(...)`: the digest.\n */";

        assert_eq!(
            rendered(doc, 0, &[section("@notice Security", &["@notice Privacy"])]),
            "/**\n * @notice Privacy:\n * - Amounts stay private.\n * @notice Security:\n * TODO\n * @dev Notation:\n * - `H(...)`: the digest.\n */"
        );
    }

    #[test]
    fn a_section_lands_after_the_block_its_heading_names_not_the_last_of_its_tag() {
        let doc =
            "/**\n * @notice Privacy:\n * - Amounts.\n * @notice Scope:\n * - Notes only.\n */";

        assert_eq!(
            rendered(doc, 0, &[section("@notice Security", &["@notice Privacy"])]),
            "/**\n * @notice Privacy:\n * - Amounts.\n * @notice Security:\n * TODO\n * @notice Scope:\n * - Notes only.\n */"
        );
    }

    #[test]
    fn listed_blocks_move_into_config_order_and_unlisted_ones_hold_their_slot() {
        let doc = "/**\n * Prose first.\n * @notice Security:\n * - Nonces.\n *\n * @param {T} a - A.\n * @module Token\n * @notice Privacy:\n * - Amounts.\n */";

        assert_eq!(
            rendered(
                doc,
                0,
                &[reorder(&["@module", "@notice Privacy", "@notice Security"])]
            ),
            "/**\n * Prose first.\n * @module Token\n *\n * @param {T} a - A.\n * @notice Privacy:\n * - Amounts.\n * @notice Security:\n * - Nonces.\n */"
        );
    }

    #[test]
    fn a_comment_already_in_order_comes_back_unchanged() {
        let doc = "/**\n * @module Token\n * @notice Privacy:\n * - Amounts.\n * @notice Security:\n * - Nonces.\n */";

        assert_eq!(
            rendered(
                doc,
                0,
                &[reorder(&["@module", "@notice Privacy", "@notice Security"])]
            ),
            doc
        );
    }

    #[test]
    fn a_single_line_doc_expands_before_a_tag_goes_in() {
        let doc = "/** @description Approved accounts. */";

        assert_eq!(
            rendered(doc, 2, &[tag("@module M", &[])]),
            "/**\n   * @module M\n   * @description Approved accounts.\n   */"
        );
    }

    #[test]
    fn constraints_follow_the_description_and_its_continuation_lines() {
        let doc = "/**\n * @description Sends a coin\n * to the recipient.\n * @param {Coin} coin - The coin.\n */";

        assert_eq!(
            rendered(
                doc,
                0,
                &[DocOp::InsertConstraints(
                    "@constraints k=?, rows=?".to_owned()
                )]
            ),
            "/**\n * @description Sends a coin\n * to the recipient.\n *\n * @constraints k=?, rows=?\n *\n * @param {Coin} coin - The coin.\n */"
        );
    }

    #[test]
    fn constraints_need_no_trailing_blank_before_the_closer() {
        let doc = "/**\n * @description Bumps.\n */";

        assert_eq!(
            rendered(
                doc,
                0,
                &[DocOp::InsertConstraints(
                    "@constraints k=?, rows=?".to_owned()
                )]
            ),
            "/**\n * @description Bumps.\n *\n * @constraints k=?, rows=?\n */"
        );
    }

    #[test]
    fn constraints_open_the_body_when_there_is_no_description() {
        let doc = "/**\n * @notice loose prose.\n */";

        assert_eq!(
            rendered(
                doc,
                0,
                &[DocOp::InsertConstraints(
                    "@constraints k=?, rows=?".to_owned()
                )]
            ),
            "/**\n * @constraints k=?, rows=?\n *\n * @notice loose prose.\n */"
        );
    }

    #[test]
    fn a_missing_description_and_missing_constraints_compose_on_one_comment() {
        let doc = "/**\n * @param {Uint<8>} value - The value.\n */";
        let composed = "/**\n * @description TODO\n *\n * @constraints k=?, rows=?\n *\n * @param {Uint<8>} value - The value.\n */";
        let tag = tag("@description TODO", &[]);
        let constraints = DocOp::InsertConstraints("@constraints k=?, rows=?".to_owned());

        assert_eq!(
            rendered(doc, 0, &[tag.clone(), constraints.clone()]),
            composed
        );
        // The rule that reports first must not decide where the annotation lands.
        assert_eq!(rendered(doc, 0, &[constraints, tag]), composed);
    }

    #[test]
    fn two_edits_on_one_comment_merge_into_a_single_replacement() {
        let source = "/**\n * @return nothing\n */\nexport circuit run(): [] { }\n";
        let edits = [
            doc_edit(
                0..26,
                0,
                DocOp::RenameTag {
                    line: 1,
                    from: "@return".to_owned(),
                    to: "@returns".to_owned(),
                },
            ),
            doc_edit(0..26, 0, tag("@description TODO", &[])),
        ];

        assert_eq!(
            apply(source, &edits, "\n"),
            "/**\n * @description TODO\n * @returns nothing\n */\nexport circuit run(): [] { }\n"
        );
    }

    #[test]
    fn an_insertion_and_a_later_comment_edit_both_land() {
        let source =
            "export ledger a: Uint<8>;\n/**\n * @return x\n */\nexport circuit run(): [] { }\n";
        let edits = [
            Edit {
                span: Span::columns(Position::file_start(), 1),
                rule: RuleId::MISSING_DOC,
                message: String::new(),
                kind: EditKind::Insert {
                    offset: 0,
                    text: "/**\n * TODO\n */\n".to_owned(),
                },
            },
            doc_edit(
                26..45,
                0,
                DocOp::RenameTag {
                    line: 1,
                    from: "@return".to_owned(),
                    to: "@returns".to_owned(),
                },
            ),
        ];

        assert_eq!(
            apply(source, &edits, "\n"),
            "/**\n * TODO\n */\nexport ledger a: Uint<8>;\n/**\n * @returns x\n */\nexport circuit run(): [] { }\n"
        );
    }

    #[test]
    fn a_rename_leaves_the_rest_of_the_line_alone() {
        assert_eq!(
            rename_tag(" * @return {[]} - Empty tuple.", "@return", "@returns"),
            Some(" * @returns {[]} - Empty tuple.".to_owned())
        );
    }

    #[test]
    fn a_rename_does_not_match_a_longer_tag() {
        assert_eq!(rename_tag(" * @returns x", "@return", "@returns"), None);
    }

    #[test]
    fn a_module_rewrite_keeps_what_follows_the_name() {
        assert_eq!(
            set_module_name(" * @module Stale<T> (archived)", "Renamed"),
            Some(" * @module Renamed (archived)".to_owned())
        );
        assert_eq!(
            set_module_name(" * @module Stale", "Renamed"),
            Some(" * @module Renamed".to_owned())
        );
    }

    #[test]
    fn a_constraints_value_is_replaced_where_it_stands() {
        let doc = "/**\n * @description Bumps.\n *\n * @constraints k=?, rows=?\n */";

        assert_eq!(
            rendered(
                doc,
                0,
                &[DocOp::SetTagValue {
                    line: 3,
                    tag: "@constraints".to_owned(),
                    value: "k=13, rows=4273".to_owned(),
                }]
            ),
            "/**\n * @description Bumps.\n *\n * @constraints k=13, rows=4273\n */"
        );
    }

    #[test]
    fn a_value_rewrite_drops_what_trailed_the_old_one() {
        assert_eq!(
            set_tag_value(
                " * @constraints k=1 rows=2 (stale)",
                "@constraints",
                "k=3, rows=4"
            ),
            Some(" * @constraints k=3, rows=4".to_owned())
        );
        assert_eq!(
            set_tag_value(" * @constraintsX k=1", "@constraints", "k=3"),
            None
        );
    }

    #[test]
    fn a_one_line_doc_keeps_its_closing_delimiter() {
        assert_eq!(
            rendered(
                "/** @constraints k=?, rows=? */",
                2,
                &[DocOp::SetTagValue {
                    line: 0,
                    tag: "@constraints".to_owned(),
                    value: "k=7, rows=74".to_owned(),
                }]
            ),
            "/** @constraints k=7, rows=74 */"
        );
    }

    #[test]
    fn crlf_sources_keep_their_line_ending() {
        let source = "/**\r\n * @description Bumps.\r\n */\r\n";
        let edits = [doc_edit(
            0..32,
            0,
            DocOp::InsertConstraints("@constraints k=?, rows=?".to_owned()),
        )];

        assert_eq!(newline_of(source), "\r\n");
        assert_eq!(
            apply(source, &edits, newline_of(source)),
            "/**\r\n * @description Bumps.\r\n *\r\n * @constraints k=?, rows=?\r\n */\r\n"
        );
    }

    #[test]
    fn a_file_without_a_trailing_newline_keeps_it_missing() {
        let source = "/**\n * @description Bumps.\n */";
        let edits = [doc_edit(0..30, 0, tag("@module M", &[]))];

        let out = apply(source, &edits, "\n");
        assert!(!out.ends_with('\n'), "{out:?}");
    }
}
