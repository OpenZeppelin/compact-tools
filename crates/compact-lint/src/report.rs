//! Findings and the one-line `path:line:col: rule: message` rendering.

use std::fmt;
use std::path::{Path, PathBuf};

/// A lint rule's stable identifier, as printed in the output and matched by CI greps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RuleId(&'static str);

impl RuleId {
    pub const MISSING_DOC: Self = Self("missing-doc");
    pub const MISSING_TAG: Self = Self("missing-tag");
    pub const FORBIDDEN_TAG: Self = Self("forbidden-tag");
    pub const MODULE_NAME: Self = Self("module-name");
    pub const MISSING_CONSTRAINTS: Self = Self("missing-constraints");
    pub const CONSTRAINTS_FORMAT: Self = Self("constraints-format");
    pub const CONSTRAINTS_PLACEHOLDER: Self = Self("constraints-placeholder");
    pub const PARSE: Self = Self("parse");
    pub const FORMAT: Self = Self("format");

    /// Every rule this build can emit, in the order the README lists them.
    pub const ALL: [Self; 9] = [
        Self::MISSING_DOC,
        Self::MISSING_TAG,
        Self::FORBIDDEN_TAG,
        Self::MODULE_NAME,
        Self::MISSING_CONSTRAINTS,
        Self::CONSTRAINTS_FORMAT,
        Self::CONSTRAINTS_PLACEHOLDER,
        Self::PARSE,
        Self::FORMAT,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for RuleId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

/// A 1-based source position; column 1 is the first byte of a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Position {
    pub line: usize,
    pub column: usize,
}

impl Position {
    /// Converts a tree-sitter 0-based row/column pair.
    #[must_use]
    pub const fn from_zero_based(row: usize, column: usize) -> Self {
        Self {
            line: row + 1,
            column: column + 1,
        }
    }

    /// The start of a file, used by whole-file findings.
    #[must_use]
    pub const fn file_start() -> Self {
        Self { line: 1, column: 1 }
    }
}

/// One lint violation at one source position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub path: PathBuf,
    pub position: Position,
    pub rule: RuleId,
    pub message: String,
}

impl Finding {
    pub fn new(
        path: impl Into<PathBuf>,
        position: Position,
        rule: RuleId,
        message: String,
    ) -> Self {
        Self {
            path: path.into(),
            position,
            rule,
            message,
        }
    }

    /// Sorts findings by file, then position, then rule, so output is stable across runs.
    #[must_use]
    pub fn sort_key(&self) -> (&Path, Position, RuleId) {
        (self.path.as_path(), self.position, self.rule)
    }
}

impl fmt::Display for Finding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}:{}:{}: {}: {}",
            self.path.display(),
            self.position.line,
            self.position.column,
            self.rule,
            self.message
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{Finding, Position, RuleId};

    #[test]
    fn finding_renders_as_path_line_col_rule_message() {
        let finding = Finding::new(
            "contracts/src/access/Ownable.compact",
            Position::from_zero_based(41, 0),
            RuleId::MISSING_DOC,
            "circuit `assertOnlyOwner` has no doc comment".to_owned(),
        );

        assert_eq!(
            finding.to_string(),
            "contracts/src/access/Ownable.compact:42:1: missing-doc: circuit `assertOnlyOwner` has no doc comment"
        );
    }

    #[test]
    fn rule_ids_are_unique() {
        let mut ids: Vec<&str> = RuleId::ALL.iter().map(|rule| rule.as_str()).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }
}
