//! Network profiles: the ledger parameters and node caps a network enforces.
//!
//! A profile is a TOML file. Three ship inside the binary, selected by name; a file on
//! disk with the same name replaces the shipped one.

use std::path::{Path, PathBuf};

use midnight_ledger_v9::structure::LedgerParameters;
use serde::Deserialize;
use thiserror::Error;

use crate::cost::Cost;
use crate::params::{self, ParamsError, ParamsIdentity};
use crate::version::Version;

/// The shipped profiles, by name.
const EMBEDDED: [(&str, &str); 3] = [
    ("mainnet", include_str!("../profiles/mainnet.toml")),
    ("preprod", include_str!("../profiles/preprod.toml")),
    ("undeployed", include_str!("../profiles/undeployed.toml")),
];

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("no shipped profile is named {name:?}; shipped: {}", shipped_names())]
    Unknown { name: String },
    #[error("cannot read profile {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot parse profile {origin}")]
    Parse {
        origin: String,
        #[source]
        source: toml::de::Error,
    },
    #[error("profile {origin}: `parameters` is not hex")]
    Hex {
        origin: String,
        #[source]
        source: hex::FromHexError,
    },
    #[error("profile {origin}: `parameters` are not valid ledger parameters")]
    Params {
        origin: String,
        #[source]
        source: ParamsError,
    },
    #[error(
        "profile {origin}: [balancing] gives some of nodes, bytes and cost; give all three or none"
    )]
    PartialBalancing { origin: String },
    #[error("profile {origin}: min_client_ledger value {value:?} is not a semantic version")]
    ClientVersion { origin: String, value: String },
    #[error("profile {origin}: a profile name is non-empty")]
    EmptyName { origin: String },
    #[error("profile {name:?} is selected twice")]
    Duplicate { name: String },
    #[error("no network selected; pass --network or --profile-file")]
    NoneSelected,
    #[error("this command takes one network, but {count} are selected")]
    NotSingle { count: usize },
}

fn shipped_names() -> String {
    EMBEDDED
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ")
}

/// One node-side cap: its value when known, and where it comes from either way.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cap {
    pub value: Option<u64>,
    pub source: String,
}

/// Caps the node adds on top of the ledger's own limits.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeCaps {
    /// Largest declared DAG node count the node deserializes.
    pub max_transaction_nodes: Cap,
    /// Weight of a transaction whose largest normalized cost dimension is 1.
    pub weight_scale: Cap,
    /// Weight added to every transaction on top of the scaled cost.
    pub fixed_extra_weight: Cap,
    /// Weight the block total adds per extrinsic, on top of its dispatch weight.
    pub base_extrinsic_weight: Cap,
    /// Largest dispatch weight of a single extrinsic, the base not included.
    pub extrinsic_weight_ceiling: Cap,
    /// Weight the Normal dispatch class may fill per block, bases included.
    pub normal_block_weight: Cap,
    /// Encoded bytes the Normal dispatch class may fill per block.
    pub normal_block_length: Cap,
}

/// What a wallet's fee payment adds to a contract transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BalancingTerm {
    pub nodes: u32,
    pub bytes: u64,
    pub cost: Cost,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BalancingFile {
    source: String,
    nodes: Option<u32>,
    bytes: Option<u64>,
    cost: Option<Cost>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileFile {
    name: String,
    #[serde(default)]
    provisional: bool,
    node_release: Option<String>,
    ledger_crate: String,
    captured: String,
    source: String,
    parameters: String,
    node: NodeCaps,
    balancing: BalancingFile,
    min_client_ledger: Option<ClientFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientFile {
    value: Option<String>,
    source: String,
}

/// The oldest npm `@midnightntwrk/ledger-v9` known to build transactions the network
/// accepts. An older client declares gas the network may refuse.
#[derive(Clone, Debug)]
pub struct ClientMinimum {
    /// `None` while unknown.
    pub version: Option<Version>,
    pub source: String,
}

/// A parsed network profile.
#[derive(Clone, Debug)]
pub struct Profile {
    pub name: String,
    /// Set while some of the profile's facts are not yet measured.
    pub provisional: bool,
    pub node_release: Option<String>,
    pub ledger_crate: String,
    pub captured: String,
    pub source: String,
    /// The tagged `LedgerParameters`, exactly as captured.
    pub parameter_bytes: Vec<u8>,
    pub parameters: LedgerParameters,
    pub identity: ParamsIdentity,
    pub node: NodeCaps,
    pub balancing_source: String,
    /// `None` while unknown; results then cover the contract's transaction only.
    pub balancing: Option<BalancingTerm>,
    pub min_client_ledger: ClientMinimum,
}

impl Profile {
    /// Parses a profile; `origin` names it in errors.
    ///
    /// # Errors
    ///
    /// The TOML is malformed, the parameters are not valid tagged `LedgerParameters`,
    /// or the balancing term is partial.
    pub fn parse(text: &str, origin: &str) -> Result<Self, ProfileError> {
        let file: ProfileFile = toml::from_str(text).map_err(|source| ProfileError::Parse {
            origin: origin.to_owned(),
            source,
        })?;
        if file.name.is_empty() {
            return Err(ProfileError::EmptyName {
                origin: origin.to_owned(),
            });
        }
        let hex_text: String = file
            .parameters
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let parameter_bytes = hex::decode(hex_text).map_err(|source| ProfileError::Hex {
            origin: origin.to_owned(),
            source,
        })?;
        let parameters =
            params::decode(&parameter_bytes).map_err(|source| ProfileError::Params {
                origin: origin.to_owned(),
                source,
            })?;
        let identity = params::identity(&parameters).map_err(|source| ProfileError::Params {
            origin: origin.to_owned(),
            source,
        })?;
        let balancing = match (
            file.balancing.nodes,
            file.balancing.bytes,
            file.balancing.cost,
        ) {
            (Some(nodes), Some(bytes), Some(cost)) => Some(BalancingTerm { nodes, bytes, cost }),
            (None, None, None) => None,
            _ => {
                return Err(ProfileError::PartialBalancing {
                    origin: origin.to_owned(),
                });
            }
        };
        let min_client_ledger = match file.min_client_ledger {
            None => ClientMinimum {
                version: None,
                source: "unknown: the profile does not say".to_owned(),
            },
            Some(ClientFile { value, source }) => ClientMinimum {
                version: value
                    .map(|value| {
                        Version::parse(&value).ok_or_else(|| ProfileError::ClientVersion {
                            origin: origin.to_owned(),
                            value,
                        })
                    })
                    .transpose()?,
                source,
            },
        };
        Ok(Profile {
            name: file.name,
            provisional: file.provisional,
            node_release: file.node_release,
            ledger_crate: file.ledger_crate,
            captured: file.captured,
            source: file.source,
            parameter_bytes,
            parameters,
            identity,
            node: file.node,
            balancing_source: file.balancing.source,
            balancing,
            min_client_ledger,
        })
    }

    /// A shipped profile.
    ///
    /// # Errors
    ///
    /// No shipped profile has that name, or the shipped file does not parse.
    pub fn embedded(name: &str) -> Result<Self, ProfileError> {
        let (_, text) = EMBEDDED
            .iter()
            .find(|(shipped, _)| *shipped == name)
            .ok_or_else(|| ProfileError::Unknown {
                name: name.to_owned(),
            })?;
        Profile::parse(text, &format!("{name} (shipped)"))
    }

    /// A profile file on disk.
    ///
    /// # Errors
    ///
    /// The file cannot be read or does not parse.
    pub fn load(path: &Path) -> Result<Self, ProfileError> {
        let text = std::fs::read_to_string(path).map_err(|source| ProfileError::Read {
            path: path.to_owned(),
            source,
        })?;
        Profile::parse(&text, &path.display().to_string())
    }
}

/// Resolves `--network` names and `--profile-file` paths, in that order.
///
/// A file whose profile name matches a requested network replaces the shipped profile
/// in place; any other file is appended.
///
/// # Errors
///
/// A name is not shipped, a file does not load, a name repeats, or nothing is selected.
pub fn select(networks: &[String], files: &[PathBuf]) -> Result<Vec<Profile>, ProfileError> {
    let loaded = files
        .iter()
        .map(|path| Profile::load(path))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, profile) in loaded.iter().enumerate() {
        if loaded[..index]
            .iter()
            .any(|earlier| earlier.name == profile.name)
        {
            return Err(ProfileError::Duplicate {
                name: profile.name.clone(),
            });
        }
    }
    let mut selected = Vec::new();
    for name in networks {
        if selected
            .iter()
            .any(|profile: &Profile| &profile.name == name)
        {
            return Err(ProfileError::Duplicate { name: name.clone() });
        }
        match loaded.iter().find(|profile| &profile.name == name) {
            Some(file) => selected.push(file.clone()),
            None => selected.push(Profile::embedded(name)?),
        }
    }
    selected.extend(
        loaded
            .into_iter()
            .filter(|profile| !networks.contains(&profile.name)),
    );
    if selected.is_empty() {
        return Err(ProfileError::NoneSelected);
    }
    Ok(selected)
}

/// [`select`] for a command that takes exactly one network.
///
/// # Errors
///
/// As [`select`], or more than one profile is selected.
pub fn select_one(networks: &[String], files: &[PathBuf]) -> Result<Profile, ProfileError> {
    let mut selected = select(networks, files)?;
    if selected.len() != 1 {
        return Err(ProfileError::NotSingle {
            count: selected.len(),
        });
    }
    Ok(selected.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_profile_parses_under_its_own_name() {
        for (name, _) in EMBEDDED {
            let profile = Profile::embedded(name).expect("the shipped profile parses");
            assert_eq!(profile.name, name);
        }
    }

    #[test]
    fn every_shipped_profile_is_measured_on_node_2_1_101() {
        for (name, _) in EMBEDDED {
            let profile = Profile::embedded(name).expect("the shipped profile parses");
            assert!(!profile.provisional, "{name}");
            assert_eq!(profile.node_release.as_deref(), Some("2.1.101"), "{name}");
            assert_eq!(
                profile.node.max_transaction_nodes.value,
                Some(1_024),
                "{name}"
            );
            assert!(profile.balancing.is_some(), "{name}");
        }
    }

    #[test]
    fn mainnet_and_preprod_share_a_params_identity() {
        let mainnet = Profile::embedded("mainnet").expect("mainnet parses");
        let preprod = Profile::embedded("preprod").expect("preprod parses");
        assert_ne!(mainnet.parameter_bytes, preprod.parameter_bytes);
        assert_eq!(mainnet.parameters.cost_model, preprod.parameters.cost_model);
        assert_eq!(mainnet.parameters.limits, preprod.parameters.limits);
        assert_eq!(mainnet.identity, preprod.identity);
    }

    #[test]
    fn undeployed_differs_from_mainnet_only_outside_the_identity() {
        let mainnet = Profile::embedded("mainnet").expect("mainnet parses");
        let local = Profile::embedded("undeployed").expect("undeployed parses");
        assert_ne!(mainnet.parameters.limits, local.parameters.limits);
        assert_eq!(mainnet.identity, local.identity);
    }

    #[test]
    fn the_identity_moves_with_a_cost_relevant_field() {
        let mainnet = Profile::embedded("mainnet").expect("mainnet parses");
        let mut changed = mainnet.parameters.clone();
        changed.limits.block_limits.block_usage += 1;
        let identity = params::identity(&changed).expect("the identity computes");
        assert_ne!(identity, mainnet.identity);
    }

    #[test]
    fn the_identity_ignores_fee_prices() {
        let mainnet = Profile::embedded("mainnet").expect("mainnet parses");
        let mut changed = mainnet.parameters.clone();
        changed.fee_prices.overall_price =
            changed.fee_prices.overall_price + changed.fee_prices.overall_price;
        let identity = params::identity(&changed).expect("the identity computes");
        assert_eq!(identity, mainnet.identity);
    }

    #[test]
    fn every_shipped_network_needs_client_ledger_1_0_2() {
        for (name, _) in EMBEDDED {
            let profile = Profile::embedded(name).expect("the profile parses");
            let minimum = profile.min_client_ledger.version.map(|v| v.to_string());
            assert_eq!(minimum.as_deref(), Some("1.0.2"), "{name}");
        }
    }

    #[test]
    fn a_minimum_that_is_not_semver_is_refused() {
        let text = EMBEDDED[0]
            .1
            .replace("value = \"1.0.2\"", "value = \"^1.0.2\"");
        assert!(matches!(
            Profile::parse(&text, "test"),
            Err(ProfileError::ClientVersion { .. })
        ));
    }

    #[test]
    fn a_partial_balancing_term_is_refused() {
        let text = EMBEDDED[0].1.replace("bytes = 3_283\n", "");
        assert!(matches!(
            Profile::parse(&text, "test"),
            Err(ProfileError::PartialBalancing { .. })
        ));
    }

    #[test]
    fn an_unknown_name_lists_the_shipped_ones() {
        let error = Profile::embedded("devnet").expect_err("devnet is not shipped");
        assert_eq!(
            error.to_string(),
            "no shipped profile is named \"devnet\"; shipped: mainnet, preprod, undeployed"
        );
    }

    #[test]
    fn a_repeated_network_is_refused() {
        let names = vec!["mainnet".to_owned(), "mainnet".to_owned()];
        assert!(matches!(
            select(&names, &[]),
            Err(ProfileError::Duplicate { .. })
        ));
    }

    #[test]
    fn two_files_with_one_profile_name_are_refused() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let files: Vec<PathBuf> = ["first.toml", "second.toml"]
            .iter()
            .map(|file| {
                let path = dir.path().join(file);
                std::fs::write(&path, EMBEDDED[0].1).expect("the profile is writable");
                path
            })
            .collect();
        let names = vec!["mainnet".to_owned()];
        assert!(matches!(
            select(&names, &files),
            Err(ProfileError::Duplicate { name }) if name == "mainnet"
        ));
    }
}
