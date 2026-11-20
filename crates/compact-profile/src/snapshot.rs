//! The committed snapshot: raw measurements and derived capacity, compared for drift.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::block::Conflict;
use crate::check::Analysis;
use crate::cost::{Cost, decimal};
use crate::fit::Largest;
use crate::limits::Limit;
use crate::series::Basis;

/// The snapshot schema this crate reads and writes.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum SnapshotError {
    #[error("cannot read snapshot {path}; `compact-profile update` writes it")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot parse snapshot {path}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("snapshot {path} has schemaVersion {found}; this build reads {SCHEMA_VERSION}")]
    Version { path: PathBuf, found: u32 },
    #[error("cannot write snapshot {path}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot serialize the snapshot")]
    Serialize(#[source] serde_json::Error),
}

/// What the ledger measured for one scenario.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Measured {
    pub cost: Cost,
    pub serialized_len: u64,
    pub declared_nodes: u32,
    #[serde(with = "decimal")]
    pub time_to_dismiss: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioSnapshot {
    pub name: String,
    pub series: Option<String>,
    pub n: Option<u64>,
    pub calls: u32,
    /// Logical operations per transaction, `calls` unless the manifest says otherwise.
    pub ops: u32,
    pub conflict: Conflict,
    pub measured: Measured,
}

/// One scenario's capacity on one network.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkScenario {
    pub name: String,
    pub fits: bool,
    /// The per-transaction limit with the highest ratio.
    pub binding: Option<Limit>,
    /// `null` when no per-block bound can be evaluated.
    pub txs_per_block: Option<u64>,
    /// A limit name, or `serial`.
    pub block_binding: Option<String>,
    pub ops_per_block: Option<u64>,
}

/// One series' capacity on one network.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkSeries {
    pub name: String,
    /// `null` with basis `fit` when no limit is predicted, and with basis `none`.
    pub max_n: Option<u64>,
    pub basis: Basis,
    pub binding: Option<Limit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkSnapshot {
    pub name: String,
    pub scenarios: Vec<NetworkScenario>,
    pub series: Vec<NetworkSeries>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub schema_version: u32,
    pub contract: String,
    pub params_identity: String,
    pub toolchain: BTreeMap<String, String>,
    pub scenarios: Vec<ScenarioSnapshot>,
    pub networks: Vec<NetworkSnapshot>,
}

impl Snapshot {
    /// The snapshot of an analysis, in manifest and network order.
    #[must_use]
    pub fn of(analysis: &Analysis) -> Snapshot {
        let manifest = &analysis.manifest;
        let scenarios = manifest
            .scenarios
            .iter()
            .zip(&analysis.measurements)
            .map(|(scenario, measurement)| ScenarioSnapshot {
                name: scenario.name.clone(),
                series: scenario.series.clone(),
                n: scenario.n,
                calls: scenario.calls,
                ops: scenario.ops(),
                conflict: scenario.conflict,
                measured: Measured {
                    cost: measurement.cost,
                    serialized_len: measurement.serialized_len,
                    declared_nodes: measurement.declared_nodes,
                    time_to_dismiss: measurement.time_to_dismiss,
                },
            })
            .collect();
        let networks = analysis
            .networks
            .iter()
            .map(|network| NetworkSnapshot {
                name: network.profile.name.clone(),
                scenarios: manifest
                    .scenarios
                    .iter()
                    .zip(network.evaluations.iter().zip(&network.capacities))
                    .map(|(scenario, (evaluation, capacity))| NetworkScenario {
                        name: scenario.name.clone(),
                        fits: evaluation.fits(),
                        binding: evaluation.binding().map(|check| check.limit),
                        txs_per_block: capacity.txs,
                        block_binding: capacity.binding.map(|binding| binding.name().to_owned()),
                        ops_per_block: capacity.ops,
                    })
                    .collect(),
                series: analysis
                    .series
                    .iter()
                    .zip(&network.series)
                    .map(|(series, capacity)| NetworkSeries {
                        name: series.name.clone(),
                        max_n: capacity.max_n.and_then(Largest::value),
                        basis: capacity.basis,
                        binding: capacity.binding,
                    })
                    .collect(),
            })
            .collect();
        Snapshot {
            schema_version: SCHEMA_VERSION,
            contract: manifest.contract.clone(),
            params_identity: manifest.params_identity.clone(),
            toolchain: manifest.toolchain.clone(),
            scenarios,
            networks,
        }
    }

    /// # Errors
    ///
    /// The file cannot be read or parsed, or has another schema version.
    pub fn load(path: &Path) -> Result<Snapshot, SnapshotError> {
        let text = std::fs::read_to_string(path).map_err(|source| SnapshotError::Read {
            path: path.to_owned(),
            source,
        })?;
        let snapshot: Snapshot =
            serde_json::from_str(&text).map_err(|source| SnapshotError::Parse {
                path: path.to_owned(),
                source,
            })?;
        if snapshot.schema_version != SCHEMA_VERSION {
            return Err(SnapshotError::Version {
                path: path.to_owned(),
                found: snapshot.schema_version,
            });
        }
        Ok(snapshot)
    }

    /// Pretty JSON with a trailing newline.
    ///
    /// # Errors
    ///
    /// Serialization fails, which a well-formed snapshot never does.
    pub fn render(&self) -> Result<String, SnapshotError> {
        let mut text = serde_json::to_string_pretty(self).map_err(SnapshotError::Serialize)?;
        text.push('\n');
        Ok(text)
    }

    /// # Errors
    ///
    /// The snapshot cannot be rendered or the file written.
    pub fn save(&self, path: &Path) -> Result<(), SnapshotError> {
        let text = self.render()?;
        std::fs::write(path, text).map_err(|source| SnapshotError::Write {
            path: path.to_owned(),
            source,
        })
    }
}

/// How one value differs between the snapshot and the current run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Changed {
        snapshot: Value,
        current: Value,
    },
    /// An entry only the current run has.
    Added,
    /// An entry only the snapshot has.
    Removed,
}

/// One drifted value, addressed like `networks[mainnet].scenarios[base-mint].fits`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Drift {
    pub path: String,
    pub change: Change,
}

impl Drift {
    /// Whether a scenario that fit in the snapshot no longer does.
    #[must_use]
    pub fn no_longer_fits(&self) -> bool {
        self.path.rsplit('.').next() == Some("fits")
            && self.change
                == Change::Changed {
                    snapshot: Value::Bool(true),
                    current: Value::Bool(false),
                }
    }
}

impl fmt::Display for Drift {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.change {
            Change::Changed { snapshot, current } => {
                write!(
                    formatter,
                    "{}: {} -> {}",
                    self.path,
                    plain(snapshot),
                    plain(current)
                )?;
                if self.no_longer_fits() {
                    formatter.write_str(" (no longer fits)")?;
                }
                Ok(())
            }
            Change::Added => write!(formatter, "{}: not in the snapshot", self.path),
            Change::Removed => write!(formatter, "{}: only in the snapshot", self.path),
        }
    }
}

/// A value as a report shows it: strings bare, `null` as `-`.
#[must_use]
pub fn plain(value: &Value) -> String {
    match value {
        Value::Null => "-".to_owned(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Every value that differs, sorted by path. `size_tolerance` is the absolute slack for
/// a scenario's `measured.serializedLen` and `measured.cost.blockUsage`.
///
/// # Errors
///
/// A snapshot fails to serialize, which a well-formed snapshot never does.
pub fn compare(
    snapshot: &Snapshot,
    current: &Snapshot,
    size_tolerance: u64,
) -> Result<Vec<Drift>, SnapshotError> {
    let before = Flat::of(snapshot)?;
    let after = Flat::of(current)?;
    let one_sided: Vec<&String> = before.items.symmetric_difference(&after.items).collect();
    // Anything inside an entry only one side has is reported once, as that entry.
    let nested = |path: &str| {
        one_sided.iter().any(|item| {
            path.len() > item.len()
                && path.starts_with(item.as_str())
                && path[item.len()..].starts_with('.')
        })
    };
    let mut drift = Vec::new();
    for item in one_sided.iter().filter(|item| !nested(item)) {
        let change = if before.items.contains(*item) {
            Change::Removed
        } else {
            Change::Added
        };
        drift.push(Drift {
            path: (*item).clone(),
            change,
        });
    }
    let paths: BTreeSet<&String> = before.values.keys().chain(after.values.keys()).collect();
    for path in paths {
        if nested(path) {
            continue;
        }
        let old = before.values.get(path).cloned().unwrap_or(Value::Null);
        let new = after.values.get(path).cloned().unwrap_or(Value::Null);
        if old == new || within_tolerance(path, &old, &new, size_tolerance) {
            continue;
        }
        drift.push(Drift {
            path: path.clone(),
            change: Change::Changed {
                snapshot: old,
                current: new,
            },
        });
    }
    drift.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(drift)
}

/// Whether `path` is one of the two size fields and the values differ by at most `tolerance`.
fn within_tolerance(path: &str, old: &Value, new: &Value, tolerance: u64) -> bool {
    let size_field =
        path.ends_with(".measured.serializedLen") || path.ends_with(".measured.cost.blockUsage");
    if tolerance == 0 || !path.starts_with("scenarios[") || !size_field {
        return false;
    }
    let number = |value: &Value| match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => decimal::parse(text),
        _ => None,
    };
    match (number(old), number(new)) {
        (Some(old), Some(new)) => old.abs_diff(new) <= tolerance,
        _ => false,
    }
}

/// A snapshot flattened to leaf paths, with named list entries addressed by name.
struct Flat {
    values: BTreeMap<String, Value>,
    /// Every named entry, like `scenarios[base-mint]`.
    items: BTreeSet<String>,
}

impl Flat {
    fn of(snapshot: &Snapshot) -> Result<Flat, SnapshotError> {
        let value = serde_json::to_value(snapshot).map_err(SnapshotError::Serialize)?;
        let mut flat = Flat {
            values: BTreeMap::new(),
            items: BTreeSet::new(),
        };
        flat.walk("", &value);
        Ok(flat)
    }

    fn walk(&mut self, path: &str, value: &Value) {
        let join = |key: &str| {
            if path.is_empty() {
                key.to_owned()
            } else {
                format!("{path}.{key}")
            }
        };
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    self.walk(&join(key), child);
                }
            }
            Value::Array(entries) if entries.iter().all(|entry| name_of(entry).is_some()) => {
                for entry in entries {
                    let item = format!("{path}[{}]", name_of(entry).unwrap_or_default());
                    self.items.insert(item.clone());
                    if let Value::Object(map) = entry {
                        for (key, child) in map.iter().filter(|(key, _)| *key != "name") {
                            self.walk(&format!("{item}.{key}"), child);
                        }
                    }
                }
            }
            leaf => {
                self.values.insert(path.to_owned(), leaf.clone());
            }
        }
    }
}

fn name_of(entry: &Value) -> Option<&str> {
    entry.get("name").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Snapshot {
        Snapshot {
            schema_version: SCHEMA_VERSION,
            contract: "Token".to_owned(),
            params_identity: "ab".to_owned(),
            toolchain: BTreeMap::from([("compactc".to_owned(), "0.36.0".to_owned())]),
            scenarios: vec![ScenarioSnapshot {
                name: "mint".to_owned(),
                series: None,
                n: None,
                calls: 1,
                ops: 1,
                conflict: Conflict::None,
                measured: Measured {
                    cost: Cost {
                        read_time: 3_978_000_000,
                        compute_time: 8_402_856_575,
                        block_usage: 10_983,
                        bytes_written: 160,
                        bytes_churned: 13_960,
                    },
                    serialized_len: 2_380,
                    declared_nodes: 89,
                    time_to_dismiss: 8_424_454_300,
                },
            }],
            networks: vec![NetworkSnapshot {
                name: "mainnet".to_owned(),
                scenarios: vec![NetworkScenario {
                    name: "mint".to_owned(),
                    fits: true,
                    binding: Some(Limit::TimeToDismiss),
                    txs_per_block: Some(35),
                    block_binding: Some("blockWeight".to_owned()),
                    ops_per_block: Some(35),
                }],
                series: Vec::new(),
            }],
        }
    }

    fn lines(drift: &[Drift]) -> Vec<String> {
        drift.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn an_identical_snapshot_has_no_drift() {
        assert_eq!(compare(&snapshot(), &snapshot(), 0).ok(), Some(Vec::new()));
    }

    #[test]
    fn exact_comparison_reports_every_changed_number() {
        let mut current = snapshot();
        current.scenarios[0].measured.serialized_len = 2_382;
        current.scenarios[0].measured.cost.compute_time += 1;
        current.networks[0].scenarios[0].txs_per_block = Some(34);
        let drift = compare(&snapshot(), &current, 0).expect("snapshots serialize");
        assert_eq!(
            lines(&drift),
            vec![
                "networks[mainnet].scenarios[mint].txsPerBlock: 35 -> 34",
                "scenarios[mint].measured.cost.computeTime: 8402856575 -> 8402856576",
                "scenarios[mint].measured.serializedLen: 2380 -> 2382",
            ]
        );
    }

    #[test]
    fn size_tolerance_covers_only_the_two_size_fields() {
        let mut current = snapshot();
        current.scenarios[0].measured.serialized_len = 2_377;
        current.scenarios[0].measured.cost.block_usage = 10_986;
        current.scenarios[0].measured.declared_nodes = 90;
        let drift = compare(&snapshot(), &current, 3).expect("snapshots serialize");
        assert_eq!(
            lines(&drift),
            vec!["scenarios[mint].measured.declaredNodes: 89 -> 90"]
        );
        let drift = compare(&snapshot(), &current, 2).expect("snapshots serialize");
        assert_eq!(drift.len(), 3);
    }

    #[test]
    fn a_scenario_that_stops_fitting_says_so() {
        let mut current = snapshot();
        current.networks[0].scenarios[0].fits = false;
        let drift = compare(&snapshot(), &current, 0).expect("snapshots serialize");
        assert_eq!(
            lines(&drift),
            vec!["networks[mainnet].scenarios[mint].fits: true -> false (no longer fits)"]
        );
    }

    #[test]
    fn added_and_removed_entries_report_once() {
        let mut current = snapshot();
        current.scenarios[0].name = "burn".to_owned();
        current.networks[0].scenarios[0].name = "burn".to_owned();
        let drift = compare(&snapshot(), &current, 0).expect("snapshots serialize");
        assert_eq!(
            lines(&drift),
            vec![
                "networks[mainnet].scenarios[burn]: not in the snapshot",
                "networks[mainnet].scenarios[mint]: only in the snapshot",
                "scenarios[burn]: not in the snapshot",
                "scenarios[mint]: only in the snapshot",
            ]
        );
    }

    #[test]
    fn a_network_only_one_side_has_reports_once() {
        let mut current = snapshot();
        let mut preprod = current.networks[0].clone();
        preprod.name = "preprod".to_owned();
        current.networks.push(preprod);
        let drift = compare(&snapshot(), &current, 0).expect("snapshots serialize");
        assert_eq!(
            lines(&drift),
            vec!["networks[preprod]: not in the snapshot"]
        );
    }

    #[test]
    fn a_toolchain_change_is_drift() {
        let mut current = snapshot();
        current
            .toolchain
            .insert("compactc".to_owned(), "0.37.0".to_owned());
        let drift = compare(&snapshot(), &current, 0).expect("snapshots serialize");
        assert_eq!(lines(&drift), vec!["toolchain.compactc: 0.36.0 -> 0.37.0"]);
    }

    #[test]
    fn a_snapshot_round_trips_through_its_rendering() {
        let text = snapshot().render().expect("the snapshot renders");
        let parsed: Snapshot = serde_json::from_str(&text).expect("the rendering parses");
        assert_eq!(parsed, snapshot());
    }
}
