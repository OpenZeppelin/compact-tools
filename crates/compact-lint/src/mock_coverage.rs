//! The `mock-coverage` rule: a module no `[mock]` rule covers, and an exported circuit no
//! generated mock exposes.
//!
//! Selection and planning come from the `compact-mock` crate, so the rule matches what
//! the generator does. The rule runs once per `check`, never writes, and reports only
//! files in the run's file list.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use compact_mock::coverage::{self, CoverageStatus, ModuleCoverage};
use thiserror::Error;

use crate::diagnostic::{Diagnostic, Level, Span};
use crate::report::{Position, RuleId};
use crate::target::{Target, normalize};

/// A `[mock]` table that fails to load.
#[derive(Debug, Error)]
#[error("cannot load the [mock] table of {}", .config.display())]
pub struct MockCoverageError {
    pub config: PathBuf,
    #[source]
    pub causes: Option<Cause>,
}

/// One compact-mock error, chained to the next so each prints as a cause line.
#[derive(Debug)]
pub struct Cause {
    message: String,
    next: Option<Box<Self>>,
}

impl Cause {
    fn chain(messages: Vec<String>) -> Option<Self> {
        messages.into_iter().rev().fold(None, |next, message| {
            Some(Self {
                message,
                next: next.map(Box::new),
            })
        })
    }
}

impl fmt::Display for Cause {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Cause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.next
            .as_deref()
            .map(|next| next as &(dyn std::error::Error + 'static))
    }
}

/// The rule's findings for the files of `target`.
/// # Errors
/// Returns [`MockCoverageError`] when the config has a `[mock]` table that fails to load.
pub fn check(
    target: &Target,
    level: Level,
    cwd: &Path,
) -> Result<Vec<Diagnostic>, MockCoverageError> {
    if level == Level::Off {
        return Ok(Vec::new());
    }
    let Some(config) = &target.config_path else {
        return Ok(Vec::new());
    };
    let modules = match coverage::coverage(config, cwd) {
        Ok(Some(modules)) => modules,
        Ok(None) => return Ok(Vec::new()),
        Err(errors) => {
            return Err(MockCoverageError {
                config: config.clone(),
                causes: Cause::chain(errors.iter().map(ToString::to_string).collect()),
            });
        }
    };
    let shown: HashMap<PathBuf, &PathBuf> = target
        .files
        .iter()
        .map(|file| (normalize(&cwd.join(file)), file))
        .collect();
    let mut found = Vec::new();
    for module in &modules {
        let Some(path) = shown.get(&normalize(&module.file)) else {
            continue;
        };
        found.extend(findings(module, path, level));
    }
    Ok(found)
}

fn findings(module: &ModuleCoverage, path: &Path, level: Level) -> Vec<Diagnostic> {
    let name_span = module
        .at
        .map(|at| span(at.line, at.column, module_name(module)));
    let at_module = |message: String| {
        let diagnostic = Diagnostic::new(path, RuleId::MOCK_COVERAGE, level, message);
        match name_span {
            Some(span) => diagnostic.at(span),
            None => diagnostic,
        }
    };
    match &module.status {
        CoverageStatus::Unmatched => vec![at_module(format!(
            "module {} has no generated mock; add it to a [[mock.rules]] glob, or to [mock].exclude if its mock stays hand-written",
            module.module
        ))],
        CoverageStatus::Failed { errors } => vec![at_module(format!(
            "compact-mock cannot plan the mocks of {}: {}",
            module.module,
            errors.first().map_or("", String::as_str)
        ))],
        CoverageStatus::Planned { mocks, uncovered } => uncovered
            .iter()
            .map(|circuit| {
                Diagnostic::new(
                    path,
                    RuleId::MOCK_COVERAGE,
                    level,
                    format!(
                        "circuit {} is exposed by no generated mock of {} ({})",
                        circuit.circuit,
                        module.module,
                        mocks.join(", ")
                    ),
                )
                .at(span(circuit.line, circuit.column, &circuit.circuit))
            })
            .collect(),
        CoverageStatus::Excluded | CoverageStatus::Skipped(_) => Vec::new(),
    }
}

/// The module's declared name: the last segment of its path.
fn module_name(module: &ModuleCoverage) -> &str {
    module.module.rsplit('/').next().unwrap_or(&module.module)
}

fn span(line: usize, column: usize, name: &str) -> Span {
    Span::new(
        Position { line, column },
        Position {
            line,
            column: column + name.len(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::Cause;

    #[test]
    fn causes_chain_in_order() {
        let cause = Cause::chain(vec!["a".to_owned(), "b".to_owned()]).expect("a chain");
        assert_eq!(cause.to_string(), "a");
        let next = std::error::Error::source(&cause).expect("a second cause");
        assert_eq!(next.to_string(), "b");
        assert!(next.source().is_none());
        assert!(Cause::chain(Vec::new()).is_none());
    }
}
