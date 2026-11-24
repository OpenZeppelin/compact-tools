//! One serialized transaction: its form, declared node count and ledger cost.

use std::fmt;

use midnight_base_crypto::cost_model::{CostDuration, SyntheticCost};
use midnight_ledger_v9::error::FeeCalculationError;
use midnight_ledger_v9::structure::{
    ContractAction, LedgerParameters, PedersenDowngradeable, ProofKind, ProofMarker,
    ProofPreimageMarker, Signature, Transaction,
};
use midnight_serialize::{Deserializable, Serializable, Tagged, tagged_deserialize};
use midnight_storage::db::InMemoryDB;
use midnight_storage::storable::Storable;
use midnight_transient_crypto::commitment::{PedersenRandomness, PureGeneratorPedersen};
use serde::Serialize;
use thiserror::Error;

use crate::cost::{Cost, Measurement, Proofs};

/// A transaction built from circuit calls, before proving.
pub type UnprovenTransaction =
    Transaction<Signature, ProofPreimageMarker, PedersenRandomness, InMemoryDB>;

/// The window the node searches for the colon that ends a tag.
const TAG_SCAN_LIMIT: usize = 512;

/// The forms a transaction takes on its way to the node, told apart by tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Form {
    /// Before proving; what a runner builds.
    Unproven,
    /// Proven, before a wallet adds its fee payment.
    Proven,
    /// Proven and balanced by a wallet, as submitted.
    Balanced,
}

impl Form {
    pub const ALL: [Form; 3] = [Form::Unproven, Form::Proven, Form::Balanced];

    /// The tag header the form serializes with.
    #[must_use]
    pub fn tag(self) -> &'static str {
        match self {
            Form::Unproven => {
                "midnight:transaction[v12](signature[v2],proof-preimage,embedded-fr[v1]):"
            }
            Form::Proven => "midnight:transaction[v12](signature[v2],proof,embedded-fr[v1]):",
            Form::Balanced => {
                "midnight:transaction[v12](signature[v2],proof,pedersen-schnorr[v1]):"
            }
        }
    }

    /// The tag header's length in bytes.
    #[must_use]
    pub fn tag_len(self) -> u64 {
        self.tag().len() as u64
    }

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Form::Unproven => "unproven",
            Form::Proven => "proven",
            Form::Balanced => "balanced",
        }
    }

    /// The form a serialized transaction's tag names.
    ///
    /// # Errors
    ///
    /// No tag ends in the scan window, or the tag names none of the three forms.
    pub fn of(payload: &[u8]) -> Result<Form, TxError> {
        let (tag, _) = split_tag(payload).ok_or(TxError::TagNotFound)?;
        Form::ALL
            .into_iter()
            .find(|form| form.tag().as_bytes() == tag)
            .ok_or_else(|| TxError::WrongTag {
                found: String::from_utf8_lossy(tag).into_owned(),
            })
    }
}

impl fmt::Display for Form {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

#[derive(Debug, Error)]
pub enum TxError {
    #[error("no tag header ends within the first {TAG_SCAN_LIMIT} bytes")]
    TagNotFound,
    #[error("tag {found:?} is not an unproven, proven or balanced transaction")]
    WrongTag { found: String },
    #[error("the declared node count after the tag is not a canonical SCALE compact u32")]
    NodeCount,
    #[error("cannot deserialize the transaction")]
    Deserialize(#[source] std::io::Error),
    #[error("the ledger cannot cost the transaction")]
    Cost(#[source] FeeCalculationError),
}

/// Splits a tagged serialization into `(tag, body)` at the second colon, as the node does.
#[must_use]
pub fn split_tag(payload: &[u8]) -> Option<(&[u8], &[u8])> {
    let (colon, _) = payload
        .iter()
        .take(TAG_SCAN_LIMIT)
        .enumerate()
        .filter(|(_, byte)| **byte == b':')
        .nth(1)?;
    Some(payload.split_at(colon + 1))
}

/// The DAG node count a transaction declares: the SCALE compact `u32` right after the tag.
///
/// # Errors
///
/// No tag ends in the scan window, or the count is truncated or not canonical.
pub fn declared_node_count(payload: &[u8]) -> Result<u32, TxError> {
    let (_, body) = split_tag(payload).ok_or(TxError::TagNotFound)?;
    decode_compact_u32(body).ok_or(TxError::NodeCount)
}

/// Decodes a SCALE compact `u32`, rejecting the non-minimal encodings the codec rejects.
fn decode_compact_u32(bytes: &[u8]) -> Option<u32> {
    let first = *bytes.first()?;
    match first & 0b11 {
        0b00 => Some(u32::from(first >> 2)),
        0b01 => {
            let value = u32::from(u16::from_le_bytes([first, *bytes.get(1)?]) >> 2);
            (value > 0x3f).then_some(value)
        }
        0b10 => {
            let value = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) >> 2;
            (value > 0x3fff).then_some(value)
        }
        _ => {
            // Big-integer mode; a u32 allows only the four-byte length.
            if first >> 2 != 0 {
                return None;
            }
            let value = u32::from_le_bytes(bytes.get(1..5)?.try_into().ok()?);
            (value > 0x3fff_ffff).then_some(value)
        }
    }
}

/// The bare extrinsic's preamble byte, then the pallet and call index of
/// `send_mn_transaction`.
const CALL_HEADER_LEN: u64 = 3;

/// The encoded extrinsic that carries a serialized transaction of `tx_len` bytes, which the
/// node's block length counts: the call header and the transaction as a SCALE `Vec<u8>`,
/// behind the SCALE compact length of both.
#[must_use]
pub fn extrinsic_len(tx_len: u64) -> u64 {
    let body = CALL_HEADER_LEN
        .saturating_add(compact_len(tx_len))
        .saturating_add(tx_len);
    compact_len(body).saturating_add(body)
}

/// Bytes in the SCALE compact encoding of `value`.
fn compact_len(value: u64) -> u64 {
    match value {
        0..=0x3f => 1,
        0x40..=0x3fff => 2,
        0x4000..=0x3fff_ffff => 4,
        // Big-integer mode: one byte, then the value's significant bytes.
        _ => 1 + u64::from((u64::BITS - value.leading_zeros()).div_ceil(8)),
    }
}

/// Deserializes an unproven transaction after checking its tag.
///
/// # Errors
///
/// The tag is missing or names another form, or the body does not deserialize.
pub fn decode(payload: &[u8]) -> Result<UnprovenTransaction, TxError> {
    match Form::of(payload)? {
        Form::Unproven => tagged_deserialize(payload).map_err(TxError::Deserialize),
        other => Err(TxError::WrongTag {
            found: other.tag().to_owned(),
        }),
    }
}

/// Measures one serialized transaction of any form under `params`.
///
/// The cost is `cost(params, false)`, which equals `cost(params, true)` whenever the
/// transaction is within its time to dismiss; the limit itself is checked in
/// [`crate::limits`] from `time_to_dismiss`.
///
/// # Errors
///
/// Any [`TxError`]: a bad tag or count, a body that does not deserialize, or a cost the
/// ledger refuses to compute.
pub fn measure(payload: &[u8], params: &LedgerParameters) -> Result<(Form, Measurement), TxError> {
    let form = Form::of(payload)?;
    let declared_nodes = declared_node_count(payload)?;
    let read = match form {
        Form::Unproven => costs::<ProofPreimageMarker, PedersenRandomness>(payload, params)?,
        Form::Proven => costs::<ProofMarker, PedersenRandomness>(payload, params)?,
        Form::Balanced => costs::<ProofMarker, PureGeneratorPedersen>(payload, params)?,
    };
    let measurement = Measurement {
        cost: plain(&read.cost),
        serialized_len: payload.len() as u64,
        declared_nodes,
        time_to_dismiss: read.time_to_dismiss.into_picoseconds(),
        proofs: read.proofs,
        intents: read.intents,
    };
    Ok((form, measurement))
}

/// What the decoded transaction gives a [`Measurement`].
struct Read {
    cost: SyntheticCost,
    time_to_dismiss: CostDuration,
    proofs: Proofs,
    intents: u64,
}

fn costs<P, B>(payload: &[u8], params: &LedgerParameters) -> Result<Read, TxError>
where
    P: ProofKind<InMemoryDB>,
    B: Storable<InMemoryDB> + PedersenDowngradeable<InMemoryDB> + Serializable,
    Transaction<Signature, P, B, InMemoryDB>: Serializable + Deserializable + Tagged,
{
    let tx: Transaction<Signature, P, B, InMemoryDB> =
        tagged_deserialize(payload).map_err(TxError::Deserialize)?;
    let intents = match &tx {
        Transaction::Standard(stx) => count(stx.intents.size()),
        Transaction::ClaimRewards(_) => 0,
    };
    Ok(Read {
        cost: tx.cost(params, false).map_err(TxError::Cost)?,
        time_to_dismiss: tx.time_to_dismiss(params).map_err(TxError::Cost)?,
        proofs: proofs(&tx),
        intents,
    })
}

/// The proofs `estimated_tx_size` sizes: one per contract call, Zswap input and output
/// (two per transient) and Dust spend.
fn proofs<P, B>(tx: &Transaction<Signature, P, B, InMemoryDB>) -> Proofs
where
    P: ProofKind<InMemoryDB>,
    B: Storable<InMemoryDB>,
{
    let Transaction::Standard(stx) = tx else {
        return Proofs::default();
    };
    let mut proofs = Proofs::default();
    for entry in stx.intents.iter() {
        let intent = &entry.1;
        let calls = intent
            .actions
            .iter_deref()
            .filter(|action| matches!(action, ContractAction::Call(_)))
            .count();
        proofs.calls = proofs.calls.saturating_add(count(calls));
        if let Some(dust) = &intent.dust_actions {
            proofs.builtin = proofs.builtin.saturating_add(count(dust.spends.len()));
        }
    }
    let guaranteed = stx.guaranteed_coins.iter().map(|offer| {
        offer_proofs(
            offer.inputs.len(),
            offer.outputs.len(),
            offer.transient.len(),
        )
    });
    let fallible = stx.fallible_coins.iter().map(|entry| {
        let offer = &entry.1;
        offer_proofs(
            offer.inputs.len(),
            offer.outputs.len(),
            offer.transient.len(),
        )
    });
    for builtin in guaranteed.chain(fallible) {
        proofs.builtin = proofs.builtin.saturating_add(builtin);
    }
    proofs
}

/// The built-in proofs of one Zswap offer: one per input and output, two per transient.
fn offer_proofs(inputs: usize, outputs: usize, transients: usize) -> u64 {
    count(inputs)
        .saturating_add(count(outputs))
        .saturating_add(count(transients).saturating_mul(2))
}

fn count(len: usize) -> u64 {
    u64::try_from(len).unwrap_or(u64::MAX)
}

fn plain(cost: &SyntheticCost) -> Cost {
    Cost {
        read_time: cost.read_time.into_picoseconds(),
        compute_time: cost.compute_time.into_picoseconds(),
        block_usage: cost.block_usage,
        bytes_written: cost.bytes_written,
        bytes_churned: cost.bytes_churned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::JsMeasurement;
    use midnight_ledger_v9::structure::StandardTransaction;

    fn payload(body: &[u8]) -> Vec<u8> {
        let mut bytes = Form::Unproven.tag().as_bytes().to_vec();
        bytes.extend_from_slice(body);
        bytes
    }

    #[test]
    fn single_byte_mode_counts_up_to_63() {
        assert_eq!(declared_node_count(&payload(&[0])).ok(), Some(0));
        assert_eq!(declared_node_count(&payload(&[63 << 2])).ok(), Some(63));
    }

    #[test]
    fn two_byte_mode_reads_the_fixture_counts() {
        // 89 and 1,002 nodes, as the base mint and the 40-call merge declare them.
        assert_eq!(declared_node_count(&payload(&[0x65, 0x01])).ok(), Some(89));
        assert_eq!(
            declared_node_count(&payload(&[0xa9, 0x0f])).ok(),
            Some(1002)
        );
        assert_eq!(
            declared_node_count(&payload(&[0xfd, 0xff])).ok(),
            Some(0x3fff)
        );
    }

    #[test]
    fn four_byte_mode_reads_above_16383() {
        let encoded = ((0x4000_u32 << 2) | 0b10).to_le_bytes();
        assert_eq!(declared_node_count(&payload(&encoded)).ok(), Some(0x4000));
    }

    #[test]
    fn big_integer_mode_reads_a_full_u32() {
        assert_eq!(
            declared_node_count(&payload(&[0b11, 0xff, 0xff, 0xff, 0xff])).ok(),
            Some(u32::MAX)
        );
    }

    #[test]
    fn non_minimal_encodings_are_rejected() {
        // 1 in two-byte mode, 63 in four-byte mode, 2^30 - 1 in big-integer mode.
        assert!(declared_node_count(&payload(&[0b0000_0101, 0])).is_err());
        assert!(declared_node_count(&payload(&((63_u32 << 2) | 0b10).to_le_bytes())).is_err());
        assert!(declared_node_count(&payload(&[0b11, 0xff, 0xff, 0xff, 0x3f])).is_err());
    }

    #[test]
    fn big_integer_mode_longer_than_a_u32_is_rejected() {
        assert!(declared_node_count(&payload(&[0b111, 0, 0, 0, 0, 1])).is_err());
    }

    #[test]
    fn truncated_counts_are_rejected() {
        assert!(declared_node_count(&payload(&[])).is_err());
        assert!(declared_node_count(&payload(&[0x65])).is_err());
        assert!(declared_node_count(&payload(&[0b10, 0, 0])).is_err());
        assert!(declared_node_count(&payload(&[0b11, 0, 0, 0])).is_err());
    }

    #[test]
    fn a_payload_without_two_colons_has_no_tag() {
        assert!(matches!(
            declared_node_count(b"midnight-transaction"),
            Err(TxError::TagNotFound)
        ));
        let mut late = vec![b'x'; TAG_SCAN_LIMIT];
        late.extend_from_slice(b"a:b:");
        assert!(split_tag(&late).is_none());
    }

    #[test]
    fn another_type_is_refused_by_tag() {
        let bytes = b"midnight:ledger-parameters[v8]:\x00".to_vec();
        assert!(matches!(decode(&bytes), Err(TxError::WrongTag { .. })));
    }

    fn fixtures() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    fn base_manifest() -> crate::manifest::Manifest {
        crate::manifest::Manifest::load(&fixtures().join("mint/manifest.json"))
            .expect("the base manifest loads")
    }

    /// A base scenario's transaction and what the runner measured for it.
    fn scenario(pick: impl Fn(&crate::manifest::Scenario) -> bool) -> (Vec<u8>, JsMeasurement) {
        let manifest = base_manifest();
        let entry = manifest
            .scenarios
            .iter()
            .find(|entry| pick(entry))
            .expect("the base manifest has the scenario");
        let bytes =
            std::fs::read(fixtures().join("mint").join(&entry.tx)).expect("the transaction exists");
        (bytes, entry.js)
    }

    fn named(name: &str) -> (Vec<u8>, JsMeasurement) {
        scenario(|entry| entry.name == name)
    }

    fn live(name: &str) -> Vec<u8> {
        std::fs::read(fixtures().join("live").join(name)).expect("the fixture exists")
    }

    #[test]
    fn each_form_is_read_by_its_tag() {
        let forms = [
            ("base-mint-proven.bin", Form::Proven, 89, 11_549),
            ("base-mint-balanced.bin", Form::Balanced, 98, 14_813),
            ("preset-mint-balanced.bin", Form::Balanced, 140, 15_194),
        ];
        for (name, form, nodes, block_usage) in forms {
            let (read, measurement) = measure(&live(name), &mainnet()).expect("it measures");
            assert_eq!(read, form, "{name}");
            assert_eq!(measurement.declared_nodes, nodes, "{name}");
            assert_eq!(measurement.cost.block_usage, block_usage, "{name}");
        }
    }

    #[test]
    fn a_proven_or_balanced_serialization_is_the_estimated_size_behind_its_tag() {
        assert_eq!(Form::Proven.tag_len(), 63);
        assert_eq!(Form::Balanced.tag_len(), 68);
        for name in [
            "base-mint-proven.bin",
            "preset-merged-n2-proven.bin",
            "base-mint-balanced.bin",
            "preset-mint-balanced.bin",
        ] {
            let (form, measurement) = measure(&live(name), &mainnet()).expect("it measures");
            assert_eq!(
                measurement.serialized_len,
                measurement.estimated_size() + form.tag_len(),
                "{name}"
            );
        }
    }

    #[test]
    fn each_compact_length_of_the_extrinsic_grows_at_16_384() {
        // The body is 16,383 bytes, then 16,384; then the transaction itself reaches 16,384.
        assert_eq!(extrinsic_len(16_378), 16_385);
        assert_eq!(extrinsic_len(16_379), 16_388);
        assert_eq!(extrinsic_len(16_383), 16_392);
        assert_eq!(extrinsic_len(16_384), 16_395);
    }

    #[test]
    fn the_extrinsic_length_matches_the_blocks_node_2_1_101_built() {
        // Recorded in tests/fixtures/README.md, under `live/`: each balanced transaction's
        // length, and its block's extrinsic bytes less the 620 of the four inherents.
        let kept = |name| {
            let (_, measurement) = measure(&live(name), &mainnet()).expect("it measures");
            measurement.serialized_len
        };
        let blocks = [
            (kept("base-mint-balanced.bin"), 15_508),
            (kept("preset-mint-balanced.bin"), 15_889),
            (26_447, 27_078),
            (326_840, 327_471),
            (433_872, 434_503),
        ];
        for (tx_len, block_bytes) in blocks {
            assert_eq!(extrinsic_len(tx_len), block_bytes - 620, "{tx_len}");
        }
    }

    #[test]
    fn the_live_multi_call_transactions_declare_their_unproven_counts() {
        let counts = [
            ("base-merged-n40-unproven.bin", 1_002),
            ("base-merged-n41-unproven.bin", 1_025),
            ("preset-merged-n29-unproven.bin", 986),
            ("preset-merged-n30-unproven.bin", 1_017),
        ];
        for (name, nodes) in counts {
            assert_eq!(declared_node_count(&live(name)).ok(), Some(nodes), "{name}");
        }
    }

    #[test]
    fn proofs_are_counted_from_the_transaction_by_kind() {
        let cases = [
            (named("mint").0, 1, 1),
            (named("mint batch of 4").0, 1, 4),
            (live("base-merged-n40-unproven.bin"), 40, 40),
            (live("base-mint-proven.bin"), 1, 1),
            // The wallet's fee payment adds one Dust spend.
            (live("base-mint-balanced.bin"), 1, 2),
        ];
        for (bytes, calls, builtin) in cases {
            let (form, measurement) = measure(&bytes, &mainnet()).expect("it measures");
            assert_eq!(measurement.proofs, Proofs { calls, builtin }, "{form}");
        }
    }

    #[test]
    fn an_offer_counts_one_proof_per_input_and_output_and_two_per_transient() {
        assert_eq!(offer_proofs(1, 0, 0), 1);
        assert_eq!(offer_proofs(0, 1, 0), 1);
        assert_eq!(offer_proofs(0, 0, 1), 2);
        assert_eq!(offer_proofs(3, 5, 7), 22);
    }

    #[test]
    fn fallible_offers_are_counted_with_the_guaranteed_one() {
        let Transaction::Standard(stx) = decode(&named("mint batch of 4").0).expect("it decodes")
        else {
            panic!("the batch is a standard transaction");
        };
        assert_eq!(stx.fallible_coins.size(), 0);
        let offer = stx
            .guaranteed_coins
            .as_deref()
            .expect("the batch has a guaranteed offer")
            .clone();
        let fallible = stx.fallible_coins.insert(1, offer);
        let variant = |guaranteed_coins| {
            Transaction::Standard(StandardTransaction {
                guaranteed_coins,
                fallible_coins: fallible.clone(),
                ..stx.clone()
            })
        };
        let only_fallible = variant(None);
        let both = variant(stx.guaranteed_coins.clone());
        assert_eq!(
            proofs(&only_fallible),
            Proofs {
                calls: 1,
                builtin: 4
            }
        );
        assert_eq!(
            proofs(&both),
            Proofs {
                calls: 1,
                builtin: 8
            }
        );
    }

    #[test]
    fn intents_are_counted_from_the_transaction() {
        let cases = [
            (named("mint").0, 1),
            (named("mint batch of 4").0, 1),
            (named("mint multi-call n=8").0, 8),
            (live("base-merged-n40-unproven.bin"), 40),
            (live("base-mint-proven.bin"), 1),
            // The wallet's fee payment is an intent of its own.
            (live("base-mint-balanced.bin"), 2),
        ];
        for (bytes, intents) in cases {
            let (form, measurement) = measure(&bytes, &mainnet()).expect("it measures");
            assert_eq!(measurement.intents, intents, "{form}");
        }
    }

    #[test]
    fn a_proven_transaction_is_not_decoded_as_unproven() {
        assert!(matches!(
            decode(&live("base-mint-proven.bin")),
            Err(TxError::WrongTag { .. })
        ));
    }

    fn mainnet() -> LedgerParameters {
        crate::profile::Profile::embedded("mainnet")
            .expect("mainnet parses")
            .parameters
    }

    #[test]
    fn a_single_mint_measures_as_the_js_ledger_did() {
        let (bytes, js) = named("mint");
        let (form, measurement) = measure(&bytes, &mainnet()).expect("it measures");
        assert_eq!(form, Form::Unproven);
        assert_eq!(measurement.cost, js.cost);
        assert_eq!(measurement.serialized_len, js.serialized_len);
        assert_eq!(measurement.declared_nodes, js.declared_nodes);
    }

    #[test]
    fn the_largest_fixture_deserializes_within_the_debug_recursion_limit() {
        let most_nodes = base_manifest()
            .scenarios
            .iter()
            .map(|entry| entry.js.declared_nodes)
            .max()
            .expect("the base manifest has scenarios");
        let (bytes, js) = scenario(|entry| entry.js.declared_nodes == most_nodes);
        let (_, measurement) = measure(&bytes, &mainnet()).expect("it measures");
        assert_eq!(measurement.declared_nodes, js.declared_nodes);
    }

    #[test]
    fn the_estimated_size_is_block_usage() {
        // With no allowance at all, the dismissal error carries the size the ledger used.
        let tx = decode(&named("mint multi-call n=8").0).expect("it decodes");
        let mut params = mainnet();
        let block_usage = tx.cost(&params, false).expect("it costs").block_usage;
        params.limits.time_to_dismiss_per_byte = CostDuration::ZERO;
        params.limits.min_time_to_dismiss = CostDuration::ZERO;
        match tx.cost(&params, true) {
            Err(FeeCalculationError::OutsideTimeToDismiss { size, .. }) => {
                assert_eq!(size, block_usage);
            }
            other => panic!("expected a dismissal error, got {other:?}"),
        }
    }

    #[test]
    fn the_ledger_enforces_dismissal_exactly_where_the_limit_check_does() {
        let tx = decode(&named("mint").0).expect("it decodes");
        let mut params = mainnet();
        let used = tx.time_to_dismiss(&params).expect("it costs");
        params.limits.min_time_to_dismiss = used;
        params.limits.time_to_dismiss_per_byte = CostDuration::ZERO;
        assert!(tx.cost(&params, true).is_ok(), "used == allowed fits");
        params.limits.min_time_to_dismiss =
            CostDuration::from_picoseconds(used.into_picoseconds() - 1);
        assert!(tx.cost(&params, true).is_err(), "used > allowed does not");
    }
}
