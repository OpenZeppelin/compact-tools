//! Which modules and circuits the generated mocks cover, for `compact-lint`'s
//! `mock-coverage` rule. Plans every mock in memory and writes nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::config::{self, Paths};
use crate::error::Error;
use crate::plan::{self, Scope, Status};
use crate::scope::Files;
use crate::select::SkipReason;
use crate::source::Position;

/// One candidate module under `src`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleCoverage {
    /// Absolute and normalized.
    pub file: PathBuf,
    /// Relative to `src`, without `.compact`.
    pub module: String,
    /// Where the module's name is written; `None` when the file holds no module.
    pub at: Option<Position>,
    pub status: CoverageStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoverageStatus {
    /// `[mock].exclude` matches it.
    Excluded,
    Skipped(SkipReason),
    /// No rule applies to it.
    Unmatched,
    Planned {
        mocks: Vec<String>,
        uncovered: Vec<Uncovered>,
    },
    /// Its mocks fail to plan; the errors as printed.
    Failed {
        errors: Vec<String>,
    },
}

/// A module circuit no mock exposes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Uncovered {
    pub circuit: String,
    pub line: usize,
    pub column: usize,
}

/// The coverage of every candidate module under the config's `src`.
///
/// `Ok(None)` when the file has no `[mock]` table.
/// # Errors
/// Returns the config's errors: a file that does not read or parse, a `[mock]` table that
/// does not validate, or a config-level error found against the sources.
pub fn coverage(config: &Path, cwd: &Path) -> Result<Option<Vec<ModuleCoverage>>, Vec<Error>> {
    let paths = Paths {
        cwd: config::normalize(cwd),
    };
    let path = paths.absolute(config);
    if !config::has_mock_table(&path, &paths).map_err(|error| vec![Error::from(error)])? {
        return Ok(None);
    }
    let config = config::load(&path, &paths)?;
    let mut files = Files::new(paths);
    let analysis = plan::analyze(&config, &mut files, Scope::default());
    if !analysis.config_errors.is_empty() {
        return Err(analysis.config_errors);
    }
    let mut found = Vec::new();
    for module in analysis.modules {
        let at = module_position(&mut files, &module.file);
        let status = match module.status {
            Status::Excluded => CoverageStatus::Excluded,
            Status::Skipped(reason) => CoverageStatus::Skipped(reason),
            Status::Unmatched => match at {
                Some(_) if plan::exports_no_circuit(&mut files, &module.file) => {
                    CoverageStatus::Skipped(SkipReason::NoExportedCircuits)
                }
                Some(_) => CoverageStatus::Unmatched,
                None => CoverageStatus::Skipped(SkipReason::NotAModule),
            },
            Status::Failed(errors) => CoverageStatus::Failed {
                errors: errors.iter().map(ToString::to_string).collect(),
            },
            Status::Mocks {
                names,
                plans,
                circuits,
                errors,
                ..
            } => {
                if errors.is_empty() {
                    let uncovered = circuits
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| !plans.iter().any(|plan| plan.covered.contains(index)))
                        .map(|(_, circuit)| Uncovered {
                            circuit: circuit.name.clone(),
                            line: circuit.at.line,
                            column: circuit.at.column,
                        })
                        .collect();
                    CoverageStatus::Planned {
                        mocks: names,
                        uncovered,
                    }
                } else {
                    CoverageStatus::Failed {
                        errors: errors.iter().map(ToString::to_string).collect(),
                    }
                }
            }
        };
        found.push(ModuleCoverage {
            file: module.file,
            module: module.module,
            at,
            status,
        });
    }
    Ok(Some(found))
}

/// Per module file, the generated sources of its mocks in expansion order. `None` when the
/// config has no `[mock]` table or it fails to load.
#[must_use]
pub fn generated_sources(config: &Path, cwd: &Path) -> Option<BTreeMap<PathBuf, Vec<PathBuf>>> {
    let paths = Paths {
        cwd: config::normalize(cwd),
    };
    let path = paths.absolute(config);
    if !config::has_mock_table(&path, &paths).ok()? {
        return None;
    }
    let config = config::load(&path, &paths).ok()?;
    let mut files = Files::new(paths);
    let analysis = plan::analyze(&config, &mut files, Scope::default());
    let mut found = BTreeMap::new();
    for module in analysis.modules {
        if let Status::Mocks {
            names, artifacts, ..
        } = module.status
        {
            let sources = names
                .iter()
                .map(|name| artifacts.join(format!("{name}.compact")))
                .collect();
            found.insert(module.file, sources);
        }
    }
    Some(found)
}

/// Where the file's module name is written, when it parses and holds a module.
fn module_position(files: &mut Files, file: &Path) -> Option<Position> {
    let id = files.require(file).ok()?;
    files.get(id).module.as_ref().map(|module| module.at)
}

#[cfg(test)]
mod tests {
    use super::{CoverageStatus, Uncovered, coverage};
    use crate::select::SkipReason;

    const MODULE: &str = "pragma language_version >= 0.28.0;\nmodule Gate {\n  export circuit initialize(n: Field): [] { }\n  export circuit open(): [] { }\n  export circuit close(): [] { }\n  export circuit spin(x: Field): [] { }\n  export circuit spin(x: Field, y: Field): [] { }\n}\n";

    fn tree(config: &str, files: &[(&str, &str)]) -> tempfile::TempDir {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        for (path, text) in files {
            let target = directory.path().join(path);
            std::fs::create_dir_all(target.parent().expect("a parent")).expect("dirs");
            std::fs::write(target, text).expect("written");
        }
        std::fs::write(directory.path().join("compact.toml"), config).expect("written");
        directory
    }

    fn statuses(directory: &tempfile::TempDir) -> Vec<(String, CoverageStatus)> {
        coverage(&directory.path().join("compact.toml"), directory.path())
            .expect("loads")
            .expect("has [mock]")
            .into_iter()
            .map(|module| (module.module, module.status))
            .collect()
    }

    #[test]
    fn a_file_without_a_mock_table_has_no_coverage() {
        let directory = tree("[lint]\n", &[]);
        assert_eq!(
            coverage(&directory.path().join("compact.toml"), directory.path()).expect("reads"),
            None
        );
    }

    #[test]
    fn a_broken_mock_table_is_an_error() {
        let directory = tree("[mock]\nsrc = \"src\"\n", &[("src/a/Gate.compact", MODULE)]);
        let errors = coverage(&directory.path().join("compact.toml"), directory.path())
            .expect_err("no rules");
        assert_eq!(
            errors[0].to_string(),
            "config compact.toml: [mock] has no [[mock.rules]] entry"
        );
    }

    #[test]
    fn each_status_is_reported_per_candidate() {
        let directory = tree(
            "[mock]\nexclude = [\"x/*\"]\n[[mock.rules]]\nmodules = [\"a/*\", \"p/*\", \"x/*\"]\nexclude = [\"close\"]\n",
            &[
                ("src/a/Gate.compact", MODULE),
                (
                    "src/b/Loose.compact",
                    "pragma language_version >= 0.28.0;\nmodule Loose {\n  export circuit go(): [] { }\n}\n",
                ),
                (
                    "src/p/Preset.compact",
                    "pragma language_version >= 0.28.0;\nexport circuit go(): [] { }\n",
                ),
                (
                    "src/x/Hand.compact",
                    MODULE.replace("Gate", "Hand").as_str(),
                ),
                (
                    "src/a/test/MockGate.fragment.compact",
                    "export circuit spin(): [] { }\n",
                ),
            ],
        );
        assert_eq!(
            statuses(&directory),
            [
                (
                    "a/Gate".to_owned(),
                    CoverageStatus::Planned {
                        mocks: vec!["MockGate".to_owned()],
                        uncovered: vec![Uncovered {
                            circuit: "close".to_owned(),
                            line: 5,
                            column: 18,
                        }],
                    }
                ),
                ("b/Loose".to_owned(), CoverageStatus::Unmatched),
                (
                    "p/Preset".to_owned(),
                    CoverageStatus::Skipped(SkipReason::NotAModule)
                ),
                ("x/Hand".to_owned(), CoverageStatus::Excluded),
            ]
        );
    }

    #[test]
    fn the_init_circuit_the_constructor_calls_and_each_overload_count_as_covered() {
        let directory = tree(
            "[mock]\n[[mock.rules]]\nmodules = [\"a/*\"]\nexclude = [\"spin\"]\n",
            &[("src/a/Gate.compact", MODULE)],
        );
        let found = statuses(&directory);
        let CoverageStatus::Planned { uncovered, .. } = &found[0].1 else {
            panic!("{found:?}");
        };
        let names: Vec<(&str, usize)> = uncovered
            .iter()
            .map(|circuit| (circuit.circuit.as_str(), circuit.line))
            .collect();
        assert_eq!(names, [("spin", 6), ("spin", 7)]);
    }

    #[test]
    fn a_module_whose_mocks_fail_to_plan_is_failed_with_its_errors() {
        let directory = tree(
            "[mock]\n[[mock.rules]]\nmodules = [\"a/Gen\"]\n",
            &[(
                "src/a/Gen.compact",
                "pragma language_version >= 0.28.0;\nmodule Gen<#N> {\n  export circuit go(): [] { }\n}\n",
            )],
        );
        assert_eq!(
            statuses(&directory),
            [(
                "a/Gen".to_owned(),
                CoverageStatus::Failed {
                    errors: vec![
                        "MockGen: a/Gen takes 1 generic arguments; set module_args or instances"
                            .to_owned()
                    ],
                }
            )]
        );
    }

    #[test]
    fn coverage_writes_nothing() {
        let directory = tree(
            "[mock]\n[[mock.rules]]\nmodules = [\"a/*\"]\n",
            &[("src/a/Gate.compact", MODULE)],
        );
        statuses(&directory);
        assert!(!directory.path().join("src/a/test").exists());
    }
}
