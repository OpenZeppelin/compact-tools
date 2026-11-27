//! The `mock-coverage` rule: a module no `[mock]` rule covers, and an exported circuit no
//! generated mock exposes.
//!
//! Selection and planning come from the `compact-mock` crate, so the rule matches what
//! the generator does. The rule runs once per `check`, never writes, and reports only
//! files in the run's file list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use compact_mock::coverage::{self, CoverageStatus, ModuleCoverage};

use crate::diagnostic::{Diagnostic, Level, Span};
use crate::report::{Position, RuleId};
use crate::target::{Target, normalize};

/// The rule's findings for the files of `target`. A `[mock]` table that fails to load is
/// one finding on the config file.
#[must_use]
pub fn check(target: &Target, level: Level, cwd: &Path) -> Vec<Diagnostic> {
    if level == Level::Off {
        return Vec::new();
    }
    let Some(config) = &target.config_path else {
        return Vec::new();
    };
    let modules = match coverage::coverage(config, cwd) {
        Ok(Some(modules)) => modules,
        Ok(None) => return Vec::new(),
        Err(errors) => {
            let first = errors.first().map(ToString::to_string).unwrap_or_default();
            let more = match errors.len() {
                0 | 1 => String::new(),
                count => format!(" (and {} more)", count - 1),
            };
            let shown = config.strip_prefix(cwd).unwrap_or(config);
            return vec![Diagnostic::new(
                shown,
                RuleId::MOCK_COVERAGE,
                level,
                format!("cannot load the [mock] table: {first}{more}"),
            )];
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
    found
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
        CoverageStatus::Skipped(reason) if reason.is_gap() => vec![at_module(format!(
            "module {} gets no generated mock: {}",
            module.module,
            reason.text()
        ))],
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
