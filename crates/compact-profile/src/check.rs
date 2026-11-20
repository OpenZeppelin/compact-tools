//! `check` and `update`: measure every scenario, compare with the runner, evaluate per network.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::block::{self, Capacity};
use crate::cost::{Dimension, Measurement};
use crate::limits::{self, Caps, Evaluation};
use crate::manifest::{Manifest, ManifestError, Scenario};
use crate::profile::Profile;
use crate::series::{self, Point, SeriesCapacity, SeriesFit};
use crate::tx::{self, Form, TxError};
use crate::version::Version;

#[derive(Debug, Error)]
pub enum CheckError {
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error("no network selected")]
    NoNetwork,
    #[error(
        "the manifest's params identity {manifest} does not match profile {network} ({profile}); \
         rebuild the transactions with the bytes `compact-profile params --network {network}` writes"
    )]
    Identity {
        network: String,
        profile: String,
        manifest: String,
    },
    #[error("scenario {scenario:?}: cannot read {path}")]
    ReadTx {
        scenario: String,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "scenario {scenario:?}: {path} is a {form} transaction; check and update read unproven \
         transactions only, as the runner builds them (cost reads every form)"
    )]
    NotUnproven {
        scenario: String,
        path: PathBuf,
        form: Form,
    },
    #[error("scenario {scenario:?}: {path}")]
    Tx {
        scenario: String,
        path: PathBuf,
        #[source]
        source: TxError,
    },
}

/// A number the Rust ledger computed differently from the runner's JS ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParityMismatch {
    pub scenario: String,
    pub field: &'static str,
    pub js: u64,
    pub rust: u64,
}

/// One size series and its fitted lines.
#[derive(Clone, Debug, PartialEq)]
pub struct SeriesResult {
    pub name: String,
    /// `(n, scenario index)`, sorted by size.
    pub members: Vec<(u64, usize)>,
    pub fit: SeriesFit,
}

/// Everything one profile says about the manifest's scenarios.
#[derive(Clone, Debug)]
pub struct NetworkResult {
    pub profile: Profile,
    pub caps: Caps,
    /// Aligned with the manifest's scenarios.
    pub evaluations: Vec<Evaluation>,
    /// Aligned with the manifest's scenarios.
    pub capacities: Vec<Capacity>,
    /// Aligned with [`Analysis::series`].
    pub series: Vec<SeriesCapacity>,
    pub client: ClientCheck,
}

/// The npm package whose version fixes the gas a transaction declares.
pub const CLIENT_LEDGER: &str = "@midnightntwrk/ledger-v9";

/// The manifest's [`CLIENT_LEDGER`] version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientVersion {
    Absent,
    Unparsable(String),
    Known(Version),
}

impl ClientVersion {
    #[must_use]
    pub fn of(manifest: &Manifest) -> ClientVersion {
        match manifest.toolchain.get(CLIENT_LEDGER) {
            None => ClientVersion::Absent,
            Some(text) => Version::parse(text).map_or_else(
                || ClientVersion::Unparsable(text.clone()),
                ClientVersion::Known,
            ),
        }
    }
}

/// The manifest's client ledger against one network's minimum.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientCheck {
    /// The network knows no minimum, or the manifest's version is unknown.
    Unchecked,
    AtLeastMinimum,
    /// A label, not a failure: the network may refuse what such a client builds.
    BelowMinimum {
        used: Version,
        minimum: Version,
    },
}

impl ClientCheck {
    #[must_use]
    pub fn of(client: &ClientVersion, profile: &Profile) -> ClientCheck {
        match (client, &profile.min_client_ledger.version) {
            (ClientVersion::Known(used), Some(minimum)) if used < minimum => {
                ClientCheck::BelowMinimum {
                    used: used.clone(),
                    minimum: minimum.clone(),
                }
            }
            (ClientVersion::Known(_), Some(_)) => ClientCheck::AtLeastMinimum,
            _ => ClientCheck::Unchecked,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Analysis {
    pub manifest: Manifest,
    /// Aligned with the manifest's scenarios.
    pub measurements: Vec<Measurement>,
    pub parity: Vec<ParityMismatch>,
    pub series: Vec<SeriesResult>,
    pub networks: Vec<NetworkResult>,
    pub client: ClientVersion,
}

/// Measures every scenario of the manifest at `manifest_path` and evaluates it on each
/// profile.
///
/// Each transaction is measured once, under the first profile's parameters: every
/// profile must share the manifest's params identity, which covers every field the
/// measurement reads.
///
/// # Errors
///
/// The manifest does not load, a profile's identity differs from the manifest's, or a
/// transaction cannot be read or measured.
pub fn analyze(manifest_path: &Path, profiles: Vec<Profile>) -> Result<Analysis, CheckError> {
    let manifest = Manifest::load(manifest_path)?;
    for profile in &profiles {
        if profile.identity.as_str() != manifest.params_identity {
            return Err(CheckError::Identity {
                network: profile.name.clone(),
                profile: profile.identity.to_string(),
                manifest: manifest.params_identity.clone(),
            });
        }
    }
    let first = profiles.first().ok_or(CheckError::NoNetwork)?;
    let base = manifest_path.parent().unwrap_or(Path::new(""));
    let measurements = manifest
        .scenarios
        .iter()
        .map(|scenario| {
            let path = base.join(&scenario.tx);
            let bytes = std::fs::read(&path).map_err(|source| CheckError::ReadTx {
                scenario: scenario.name.clone(),
                path: path.clone(),
                source,
            })?;
            let tx_error = |source| CheckError::Tx {
                scenario: scenario.name.clone(),
                path: path.clone(),
                source,
            };
            let form = Form::of(&bytes).map_err(tx_error)?;
            if form != Form::Unproven {
                return Err(CheckError::NotUnproven {
                    scenario: scenario.name.clone(),
                    path,
                    form,
                });
            }
            let (_, measurement) = tx::measure(&bytes, &first.parameters).map_err(tx_error)?;
            Ok(measurement)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let parity = manifest
        .scenarios
        .iter()
        .zip(&measurements)
        .flat_map(|(scenario, measurement)| parity(scenario, measurement))
        .collect();
    let series: Vec<SeriesResult> = manifest
        .series()
        .into_iter()
        .map(|(name, members)| {
            let points: Vec<(u64, &Measurement)> = members
                .iter()
                .map(|(n, index)| (*n, &measurements[*index]))
                .collect();
            SeriesResult {
                name: name.to_owned(),
                fit: SeriesFit::of(&points),
                members,
            }
        })
        .collect();
    let networks = profiles
        .into_iter()
        .map(|profile| evaluate_network(profile, &manifest, &measurements, &series))
        .collect();
    let client = ClientVersion::of(&manifest);
    Ok(Analysis {
        manifest,
        measurements,
        parity,
        series,
        networks,
        client,
    })
}

/// Every number of `measurement` that differs from what the runner reported.
fn parity(scenario: &Scenario, measurement: &Measurement) -> Vec<ParityMismatch> {
    let js = &scenario.js;
    let mut pairs: Vec<(&'static str, u64, u64)> = Dimension::ALL
        .into_iter()
        .map(|dimension| {
            (
                dimension.name(),
                js.cost.get(dimension),
                measurement.cost.get(dimension),
            )
        })
        .collect();
    pairs.push((
        "serializedLen",
        js.serialized_len,
        measurement.serialized_len,
    ));
    pairs.push((
        "declaredNodes",
        u64::from(js.declared_nodes),
        u64::from(measurement.declared_nodes),
    ));
    pairs
        .into_iter()
        .filter(|(_, js, rust)| js != rust)
        .map(|(field, js, rust)| ParityMismatch {
            scenario: scenario.name.clone(),
            field,
            js,
            rust,
        })
        .collect()
}

fn evaluate_network(
    profile: Profile,
    manifest: &Manifest,
    measurements: &[Measurement],
    series: &[SeriesResult],
) -> NetworkResult {
    let caps = Caps::of(&profile);
    let evaluations: Vec<Evaluation> = measurements
        .iter()
        .map(|measurement| limits::evaluate(measurement, &caps))
        .collect();
    let capacities = manifest
        .scenarios
        .iter()
        .zip(&evaluations)
        .map(|(scenario, evaluation)| {
            block::capacity(evaluation, &caps, scenario.conflict, scenario.ops())
        })
        .collect();
    let series = series
        .iter()
        .map(|result| {
            let points: Vec<Point<'_>> = result
                .members
                .iter()
                .map(|(n, index)| Point {
                    n: *n,
                    measurement: &measurements[*index],
                    fits: evaluations[*index].fits(),
                    binding: evaluations[*index].binding().map(|check| check.limit),
                })
                .collect();
            series::capacity(&result.fit, &points, &caps)
        })
        .collect();
    let client = ClientCheck::of(&ClientVersion::of(manifest), &profile);
    NetworkResult {
        profile,
        caps,
        evaluations,
        capacities,
        series,
        client,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn manifest(client: Option<&str>) -> Manifest {
        Manifest {
            schema_version: crate::manifest::SCHEMA_VERSION,
            contract: "Token".to_owned(),
            toolchain: client
                .map(|version| BTreeMap::from([(CLIENT_LEDGER.to_owned(), version.to_owned())]))
                .unwrap_or_default(),
            params_identity: String::new(),
            scenarios: Vec::new(),
        }
    }

    fn check(client: Option<&str>, network: &str) -> ClientCheck {
        let profile = Profile::embedded(network).expect("the profile parses");
        ClientCheck::of(&ClientVersion::of(&manifest(client)), &profile)
    }

    #[test]
    fn a_release_candidate_is_below_the_release_minimum() {
        assert!(matches!(
            check(Some("1.0.0-rc.5"), "mainnet"),
            ClientCheck::BelowMinimum { .. }
        ));
        assert_eq!(check(Some("1.0.2"), "mainnet"), ClientCheck::AtLeastMinimum);
    }

    #[test]
    fn an_absent_or_unparsable_client_or_minimum_is_unchecked() {
        assert_eq!(check(None, "mainnet"), ClientCheck::Unchecked);
        assert_eq!(check(Some("^1.0.2"), "mainnet"), ClientCheck::Unchecked);
        assert_eq!(
            check(Some("1.0.0-rc.5"), "undeployed"),
            ClientCheck::Unchecked
        );
        assert_eq!(
            ClientVersion::of(&manifest(Some("latest"))),
            ClientVersion::Unparsable("latest".to_owned())
        );
    }
}
