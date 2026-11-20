//! Ledger parameters: decoding the tagged bytes and the identity a manifest pins.

use std::fmt;

use midnight_ledger_v9::structure::LedgerParameters;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Prefixes the identity preimage, so a change of field set changes every identity.
const IDENTITY_DOMAIN: &[u8] = b"compact-profile:params-identity[v1]:";

#[derive(Debug, Error)]
pub enum ParamsError {
    #[error("cannot deserialize the ledger parameters")]
    Deserialize(#[source] std::io::Error),
    #[error("the ledger parameters do not re-serialize to the same bytes")]
    NotCanonical,
    #[error("cannot serialize the ledger parameters")]
    Serialize(#[source] std::io::Error),
}

/// Hex SHA-256 over the parameter fields a transaction's cost depends on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParamsIdentity(String);

impl ParamsIdentity {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ParamsIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Decodes tagged `LedgerParameters`, insisting the bytes are their canonical form.
///
/// # Errors
///
/// The bytes do not deserialize, or deserialize but re-serialize differently.
pub fn decode(bytes: &[u8]) -> Result<LedgerParameters, ParamsError> {
    let params: LedgerParameters = tagged_deserialize(bytes).map_err(ParamsError::Deserialize)?;
    let mut again = Vec::with_capacity(bytes.len());
    tagged_serialize(&params, &mut again).map_err(ParamsError::Serialize)?;
    if again != bytes {
        return Err(ParamsError::NotCanonical);
    }
    Ok(params)
}

/// The identity of the fields `Transaction::cost` and transcript partitioning read.
///
/// In `midnight-ledger-v9` 1.0.1 those are:
/// - `cost_model`: validation, application and effects-check costs, and the
///   partitioning gas heuristic (`structure.rs:2303-2475`, `construct.rs:732-881`, `:1101`);
/// - `limits.block_limits`: the deploy copy budget (`structure.rs:2503-2504`);
/// - `limits.time_to_dismiss_per_byte` and `limits.min_time_to_dismiss`: the dismissal
///   check (`structure.rs:2635-2638`) and the partition budgets (`construct.rs:743`, `:1103`).
///
/// Fee prices and the other fields move between captures without changing any cost, so
/// they stay out. `transaction_byte_limit` is read only by the limit checks, which take
/// it from the profile.
///
/// # Errors
///
/// A field fails to serialize, which an in-memory writer never does.
pub fn identity(params: &LedgerParameters) -> Result<ParamsIdentity, ParamsError> {
    let mut preimage = IDENTITY_DOMAIN.to_vec();
    tagged_serialize(&params.cost_model, &mut preimage).map_err(ParamsError::Serialize)?;
    tagged_serialize(&params.limits.block_limits, &mut preimage).map_err(ParamsError::Serialize)?;
    tagged_serialize(&params.limits.time_to_dismiss_per_byte, &mut preimage)
        .map_err(ParamsError::Serialize)?;
    tagged_serialize(&params.limits.min_time_to_dismiss, &mut preimage)
        .map_err(ParamsError::Serialize)?;
    Ok(ParamsIdentity(hex::encode(Sha256::digest(&preimage))))
}
