//! Rule identifiers and source positions.

use std::fmt;

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
    pub const CONSTRAINTS_UNMEASURED: Self = Self("constraints-unmeasured");
    pub const CONSTRAINTS_UNMEASURABLE: Self = Self("constraints-unmeasurable");
    pub const PARSE: Self = Self("parse");
    pub const FORMAT: Self = Self("format");

    /// A value `fill-constraints` wrote. It reports what changed, so it takes no level.
    pub const FILL: Self = Self("fill");

    /// Every rule a `[rules]` table can set a level for, in the order the README lists them.
    pub const ALL: [Self; 11] = [
        Self::MISSING_DOC,
        Self::MISSING_TAG,
        Self::FORBIDDEN_TAG,
        Self::MODULE_NAME,
        Self::MISSING_CONSTRAINTS,
        Self::CONSTRAINTS_FORMAT,
        Self::CONSTRAINTS_PLACEHOLDER,
        Self::CONSTRAINTS_UNMEASURED,
        Self::CONSTRAINTS_UNMEASURABLE,
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

#[cfg(test)]
mod tests {
    use super::RuleId;

    #[test]
    fn rule_ids_are_unique() {
        let mut ids: Vec<&str> = RuleId::ALL.iter().map(|rule| rule.as_str()).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }
}
