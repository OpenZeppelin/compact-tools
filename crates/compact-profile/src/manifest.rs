//! The manifest a runner writes: one entry per scenario and its serialized transaction.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::block::Conflict;
use crate::cost::Cost;

/// The manifest schema this crate reads.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("cannot read manifest {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot parse manifest {path}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("manifest {path} has schemaVersion {found}; this build reads {SCHEMA_VERSION}")]
    Version { path: PathBuf, found: u32 },
    #[error("manifest {path}: {problem}")]
    Invalid { path: PathBuf, problem: String },
}

/// What the runner measured with the JS ledger, compared against the Rust ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsMeasurement {
    pub cost: Cost,
    pub serialized_len: u64,
    pub declared_nodes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    pub name: String,
    /// Scenarios sharing a series name form a size series.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    /// The size within the series; required with `series`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u64>,
    /// Contract calls in the transaction.
    pub calls: u32,
    /// Logical operations the transaction performs, such as mints in a batch circuit;
    /// defaults to `calls`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ops: Option<u32>,
    pub conflict: Conflict,
    /// The serialized transaction, relative to the manifest's directory.
    pub tx: String,
    pub js: JsMeasurement,
}

impl Scenario {
    /// Logical operations per transaction: `ops` when given, else `calls`.
    #[must_use]
    pub fn ops(&self) -> u32 {
        self.ops.unwrap_or(self.calls)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub contract: String,
    /// Free-form tool and package versions, compared with the snapshot's.
    pub toolchain: BTreeMap<String, String>,
    /// The `compact-profile params` identity of the parameters the runner used.
    pub params_identity: String,
    pub scenarios: Vec<Scenario>,
}

impl Manifest {
    /// Reads and validates a manifest.
    ///
    /// # Errors
    ///
    /// The file cannot be read or parsed, has another schema version, or breaks a rule
    /// [`Manifest::validate`] checks.
    pub fn load(path: &Path) -> Result<Manifest, ManifestError> {
        let text = std::fs::read_to_string(path).map_err(|source| ManifestError::Read {
            path: path.to_owned(),
            source,
        })?;
        let manifest: Manifest =
            serde_json::from_str(&text).map_err(|source| ManifestError::Parse {
                path: path.to_owned(),
                source,
            })?;
        if manifest.schema_version != SCHEMA_VERSION {
            return Err(ManifestError::Version {
                path: path.to_owned(),
                found: manifest.schema_version,
            });
        }
        manifest
            .validate()
            .map_err(|problem| ManifestError::Invalid {
                path: path.to_owned(),
                problem,
            })?;
        Ok(manifest)
    }

    /// Checks the rules the schema cannot express.
    ///
    /// # Errors
    ///
    /// The first problem found, as a sentence.
    pub fn validate(&self) -> Result<(), String> {
        if self.scenarios.is_empty() {
            return Err("lists no scenarios".to_owned());
        }
        for (index, scenario) in self.scenarios.iter().enumerate() {
            let name = &scenario.name;
            if name.is_empty() {
                return Err(format!("scenario {index} has an empty name"));
            }
            if self.scenarios[..index]
                .iter()
                .any(|earlier| &earlier.name == name)
            {
                return Err(format!("scenario {name:?} appears twice"));
            }
            if scenario.calls == 0 {
                return Err(format!("scenario {name:?} has 0 calls"));
            }
            if scenario.ops == Some(0) {
                return Err(format!("scenario {name:?} has 0 ops"));
            }
            if Path::new(&scenario.tx).is_absolute() {
                return Err(format!(
                    "scenario {name:?} has an absolute tx path; tx is relative to the manifest"
                ));
            }
            match (&scenario.series, scenario.n) {
                (Some(_), None) => return Err(format!("scenario {name:?} has a series but no n")),
                (None, Some(_)) => return Err(format!("scenario {name:?} has an n but no series")),
                (Some(series), Some(n)) => {
                    if self.scenarios[..index].iter().any(|earlier| {
                        earlier.series.as_ref() == Some(series) && earlier.n == Some(n)
                    }) {
                        return Err(format!("series {series:?} lists n = {n} twice"));
                    }
                }
                (None, None) => {}
            }
        }
        Ok(())
    }

    /// Series names in first-appearance order, each with its members sorted by size.
    #[must_use]
    pub fn series(&self) -> Vec<(&str, Vec<(u64, usize)>)> {
        let mut series: Vec<(&str, Vec<(u64, usize)>)> = Vec::new();
        for (index, scenario) in self.scenarios.iter().enumerate() {
            let (Some(name), Some(n)) = (scenario.series.as_deref(), scenario.n) else {
                continue;
            };
            match series.iter_mut().find(|(existing, _)| *existing == name) {
                Some((_, members)) => members.push((n, index)),
                None => series.push((name, vec![(n, index)])),
            }
        }
        for (_, members) in &mut series {
            members.sort_unstable();
        }
        series
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scenario(name: &str, series: Option<&str>, n: Option<u64>) -> Scenario {
        Scenario {
            name: name.to_owned(),
            series: series.map(str::to_owned),
            n,
            calls: 1,
            ops: None,
            conflict: Conflict::None,
            tx: format!("txs/{name}.bin"),
            js: JsMeasurement {
                cost: Cost::default(),
                serialized_len: 0,
                declared_nodes: 0,
            },
        }
    }

    fn manifest(scenarios: Vec<Scenario>) -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            contract: "Token".to_owned(),
            toolchain: BTreeMap::new(),
            params_identity: String::new(),
            scenarios,
        }
    }

    #[test]
    fn series_group_by_name_and_sort_by_size() {
        let manifest = manifest(vec![
            scenario("b4", Some("b"), Some(4)),
            scenario("single", None, None),
            scenario("b1", Some("b"), Some(1)),
            scenario("a2", Some("a"), Some(2)),
        ]);
        assert_eq!(manifest.validate(), Ok(()));
        assert_eq!(
            manifest.series(),
            vec![("b", vec![(1, 2), (4, 0)]), ("a", vec![(2, 3)])]
        );
    }

    #[test]
    fn ops_default_to_calls() {
        let mut batch = scenario("batch", None, None);
        batch.calls = 3;
        assert_eq!(batch.ops(), 3);
        batch.ops = Some(8);
        assert_eq!(batch.ops(), 8);
    }

    #[test]
    fn zero_ops_are_refused() {
        let mut none = scenario("x", None, None);
        none.ops = Some(0);
        assert_eq!(
            manifest(vec![none]).validate(),
            Err("scenario \"x\" has 0 ops".to_owned())
        );
    }

    #[test]
    fn a_repeated_name_is_refused() {
        let manifest = manifest(vec![scenario("x", None, None), scenario("x", None, None)]);
        assert_eq!(
            manifest.validate(),
            Err("scenario \"x\" appears twice".to_owned())
        );
    }

    #[test]
    fn a_series_needs_a_size_and_a_size_needs_a_series() {
        let no_n = manifest(vec![scenario("x", Some("s"), None)]);
        assert!(no_n.validate().is_err());
        let no_series = manifest(vec![scenario("x", None, Some(1))]);
        assert!(no_series.validate().is_err());
    }

    #[test]
    fn a_repeated_size_in_a_series_is_refused() {
        let manifest = manifest(vec![
            scenario("x", Some("s"), Some(2)),
            scenario("y", Some("s"), Some(2)),
        ]);
        assert_eq!(
            manifest.validate(),
            Err("series \"s\" lists n = 2 twice".to_owned())
        );
    }

    #[test]
    fn an_absolute_tx_path_is_refused() {
        let mut absolute = scenario("x", None, None);
        absolute.tx = "/tmp/x.bin".to_owned();
        assert!(manifest(vec![absolute]).validate().is_err());
    }

    #[test]
    fn an_unknown_field_is_refused() {
        let json = r#"{"schemaVersion":1,"contract":"T","toolchain":{},"paramsIdentity":"",
            "scenarios":[],"extra":1}"#;
        assert!(serde_json::from_str::<Manifest>(json).is_err());
    }
}
