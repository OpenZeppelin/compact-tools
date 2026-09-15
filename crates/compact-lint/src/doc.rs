//! Parsing of `/** … */` doc comments into an ordered tag list.

use std::fmt;

use serde::Deserialize;

/// A doc-comment tag name, stored with its leading `@` (`@description`).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(transparent)]
pub struct Tag(String);

impl Tag {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `@` followed by at least one ASCII letter, the same shape the parser recognises.
    #[must_use]
    pub fn is_well_formed(&self) -> bool {
        self.0.strip_prefix('@').is_some_and(|name| {
            !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphabetic())
        })
    }
}

impl fmt::Display for Tag {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// One tag occurrence: its name, its value, and where it sits inside the comment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagOccurrence {
    pub tag: Tag,
    pub value: String,
    /// 0-based line index inside the doc comment, counted from the `/**` line.
    pub line_offset: usize,
    /// 0-based byte offset of the `@` in its line; on the first line, counted after `/**`.
    pub column_offset: usize,
}

/// A parsed doc comment. Repeated tags (`@param`) are kept in source order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DocComment {
    tags: Vec<TagOccurrence>,
}

impl DocComment {
    /// Parses the raw `/** … */` text, stripping the delimiters and the ` * ` gutter.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let opened = raw.strip_prefix("/**").unwrap_or(raw);
        let inner = opened.strip_suffix("*/").unwrap_or(opened);

        let mut tags: Vec<TagOccurrence> = Vec::new();
        let mut open: Option<usize> = None;

        for (line_offset, line) in inner.lines().enumerate() {
            let content = strip_gutter(line).trim();

            if content.is_empty() {
                open = None;
                continue;
            }

            if let Some((tag, value)) = split_tag(content) {
                tags.push(TagOccurrence {
                    tag,
                    value: value.to_owned(),
                    line_offset,
                    column_offset: line.find('@').unwrap_or(0),
                });
                open = Some(tags.len() - 1);
                continue;
            }

            // A non-blank, non-tag line continues the tag above it.
            if let Some(index) = open
                && let Some(occurrence) = tags.get_mut(index)
            {
                if !occurrence.value.is_empty() {
                    occurrence.value.push('\n');
                }
                occurrence.value.push_str(content);
            }
        }

        Self { tags }
    }

    /// Every tag occurrence, in source order.
    #[must_use]
    pub fn tags(&self) -> &[TagOccurrence] {
        &self.tags
    }

    #[must_use]
    pub fn has(&self, tag: &Tag) -> bool {
        self.tags.iter().any(|occurrence| &occurrence.tag == tag)
    }

    /// The first occurrence of `tag`, which is the one every rule reads.
    #[must_use]
    pub fn first(&self, tag: &Tag) -> Option<&TagOccurrence> {
        self.tags.iter().find(|occurrence| &occurrence.tag == tag)
    }

    /// The value of the first occurrence of `tag`.
    #[must_use]
    pub fn value(&self, tag: &Tag) -> Option<&str> {
        self.first(tag).map(|occurrence| occurrence.value.as_str())
    }
}

/// Removes the leading whitespace, one `*`, and one following space from a comment line.
fn strip_gutter(line: &str) -> &str {
    let trimmed = line.trim_start();
    match trimmed.strip_prefix('*') {
        Some(rest) => rest.strip_prefix(' ').unwrap_or(rest),
        None => trimmed,
    }
}

/// A tag line starts with `@` followed by at least one ASCII letter.
fn split_tag(content: &str) -> Option<(Tag, &str)> {
    let rest = content.strip_prefix('@')?;
    let name_len = rest
        .find(|character: char| !character.is_ascii_alphabetic())
        .unwrap_or(rest.len());
    if name_len == 0 {
        return None;
    }

    let (name, value) = rest.split_at(name_len);
    Some((Tag::new(format!("@{name}")), value.trim()))
}

#[cfg(test)]
mod tests {
    use super::{DocComment, Tag};

    #[test]
    fn gutter_and_delimiters_are_stripped() {
        let doc = DocComment::parse("/**\n * @description Adds two numbers.\n */");

        assert_eq!(doc.tags().len(), 1);
        assert_eq!(doc.tags()[0].tag, Tag::new("@description"));
        assert_eq!(doc.tags()[0].value, "Adds two numbers.");
        assert_eq!(doc.tags()[0].line_offset, 1);
        assert_eq!(doc.tags()[0].column_offset, 3);
    }

    #[test]
    fn a_blank_line_ends_a_value() {
        let doc = DocComment::parse("/**\n * @notice first\n *\n * loose prose\n */");

        assert_eq!(doc.value(&Tag::new("@notice")), Some("first"));
    }

    #[test]
    fn a_non_tag_line_continues_the_tag_above_it() {
        let doc = DocComment::parse("/**\n * @notice first\n * second\n */");

        assert_eq!(doc.value(&Tag::new("@notice")), Some("first\nsecond"));
    }

    #[test]
    fn repeated_tags_keep_source_order() {
        let doc = DocComment::parse(
            "/**\n * @param {Uint<8>} a - left\n * @param {Uint<8>} b - right\n */",
        );

        let params: Vec<&str> = doc
            .tags()
            .iter()
            .filter(|occurrence| occurrence.tag == Tag::new("@param"))
            .map(|occurrence| occurrence.value.as_str())
            .collect();
        assert_eq!(params, ["{Uint<8>} a - left", "{Uint<8>} b - right"]);
    }

    #[test]
    fn return_and_returns_are_distinct_tags() {
        let doc = DocComment::parse("/**\n * @returns The sum.\n */");

        assert!(doc.has(&Tag::new("@returns")));
        assert!(!doc.has(&Tag::new("@return")));
    }

    #[test]
    fn an_at_sign_without_letters_is_not_a_tag() {
        let doc = DocComment::parse("/**\n * @1234 not a tag\n * mail@example.com\n */");

        assert!(doc.tags().is_empty());
    }

    #[test]
    fn a_single_line_comment_parses() {
        let doc = DocComment::parse("/** @description One liner. */");

        assert_eq!(doc.value(&Tag::new("@description")), Some("One liner."));
        assert_eq!(doc.tags()[0].line_offset, 0);
        assert_eq!(doc.tags()[0].column_offset, 1);
    }
}
