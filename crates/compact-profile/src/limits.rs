//! Per-transaction limits: each as used against allowed, and the one that binds.

use std::cmp::Ordering;
use std::fmt;

use midnight_base_crypto::cost_model::FixedPoint;
use serde::{Deserialize, Serialize};

use crate::cost::{Cost, Dimension, Measurement};
use crate::profile::{BalancingTerm, Profile, ProofTerm};
use crate::tx::Form;

/// The numbers the limit checks read from a profile. `None` is an unknown node cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub transaction_byte_limit: u64,
    pub time_to_dismiss_per_byte: u64,
    pub min_time_to_dismiss: u64,
    pub block_limits: Cost,
    pub max_transaction_nodes: Option<u64>,
    pub weight_scale: Option<u64>,
    pub fixed_extra_weight: Option<u64>,
    pub base_extrinsic_weight: Option<u64>,
    pub extrinsic_weight_ceiling: Option<u64>,
    pub normal_block_weight: Option<u64>,
    pub normal_block_length: Option<u64>,
    pub balancing: Option<BalancingTerm>,
    pub proof: Option<ProofTerm>,
}

impl Caps {
    #[must_use]
    pub fn of(profile: &Profile) -> Caps {
        let limits = &profile.parameters.limits;
        let block = &limits.block_limits;
        Caps {
            transaction_byte_limit: limits.transaction_byte_limit,
            time_to_dismiss_per_byte: limits.time_to_dismiss_per_byte.into_picoseconds(),
            min_time_to_dismiss: limits.min_time_to_dismiss.into_picoseconds(),
            block_limits: Cost {
                read_time: block.read_time.into_picoseconds(),
                compute_time: block.compute_time.into_picoseconds(),
                block_usage: block.block_usage,
                bytes_written: block.bytes_written,
                bytes_churned: block.bytes_churned,
            },
            max_transaction_nodes: profile.node.max_transaction_nodes.value,
            weight_scale: profile.node.weight_scale.value,
            fixed_extra_weight: profile.node.fixed_extra_weight.value,
            base_extrinsic_weight: profile.node.base_extrinsic_weight.value,
            extrinsic_weight_ceiling: profile.node.extrinsic_weight_ceiling.value,
            normal_block_weight: profile.node.normal_block_weight.value,
            normal_block_length: profile.node.normal_block_length.value,
            balancing: profile.balancing,
            proof: profile.proof,
        }
    }

    /// The node's dispatch weight for a cost: the scaled cost plus the fixed extra weight.
    /// `None` while either is unknown.
    #[must_use]
    pub fn dispatch_weight(&self, cost: &Cost) -> Option<u64> {
        let scaled = scaled_cost(cost, &self.block_limits, self.weight_scale?);
        Some(scaled.saturating_add(self.fixed_extra_weight?))
    }

    /// What one transaction adds to the Normal class's block total: its dispatch weight
    /// plus the base extrinsic weight. `None` while any part is unknown.
    #[must_use]
    pub fn block_weight(&self, cost: &Cost) -> Option<u64> {
        Some(
            self.dispatch_weight(cost)?
                .saturating_add(self.base_extrinsic_weight?),
        )
    }

    /// The allowed time to dismiss for an estimated size, as `checked_cost` computes it.
    #[must_use]
    pub fn time_to_dismiss_allowed(&self, estimated_size: u64) -> u64 {
        self.time_to_dismiss_per_byte
            .saturating_mul(estimated_size)
            .max(self.min_time_to_dismiss)
    }
}

/// A per-transaction limit, in report order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Limit {
    /// Declared DAG nodes against the node's cap.
    Nodes,
    /// Estimated size against the ledger's `transaction_byte_limit`.
    TxBytes,
    ReadTime,
    ComputeTime,
    BlockUsage,
    BytesWritten,
    BytesChurned,
    /// Dismissal time against `max(per_byte * estimated size, min)`.
    TimeToDismiss,
    /// Weight against the node's per-extrinsic ceiling.
    ExtrinsicWeight,
    /// Weight against the Normal class's share of a block.
    BlockWeight,
    /// Estimated size against the Normal class's share of a block's length.
    BlockLength,
}

impl Limit {
    pub const ALL: [Limit; 11] = [
        Limit::Nodes,
        Limit::TxBytes,
        Limit::ReadTime,
        Limit::ComputeTime,
        Limit::BlockUsage,
        Limit::BytesWritten,
        Limit::BytesChurned,
        Limit::TimeToDismiss,
        Limit::ExtrinsicWeight,
        Limit::BlockWeight,
        Limit::BlockLength,
    ];

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Limit::Nodes => "nodes",
            Limit::TxBytes => "txBytes",
            Limit::ReadTime => Dimension::ReadTime.name(),
            Limit::ComputeTime => Dimension::ComputeTime.name(),
            Limit::BlockUsage => Dimension::BlockUsage.name(),
            Limit::BytesWritten => Dimension::BytesWritten.name(),
            Limit::BytesChurned => Dimension::BytesChurned.name(),
            Limit::TimeToDismiss => "timeToDismiss",
            Limit::ExtrinsicWeight => "extrinsicWeight",
            Limit::BlockWeight => "blockWeight",
            Limit::BlockLength => "blockLength",
        }
    }

    #[must_use]
    pub fn of(dimension: Dimension) -> Limit {
        match dimension {
            Dimension::ReadTime => Limit::ReadTime,
            Dimension::ComputeTime => Limit::ComputeTime,
            Dimension::BlockUsage => Limit::BlockUsage,
            Dimension::BytesWritten => Limit::BytesWritten,
            Dimension::BytesChurned => Limit::BytesChurned,
        }
    }
}

impl fmt::Display for Limit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Status {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "over")]
    Over,
    /// The used or the allowed side depends on an unknown profile field.
    #[serde(rename = "n/a")]
    NotApplicable,
}

impl Status {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Over => "over",
            Status::NotApplicable => "n/a",
        }
    }
}

/// `used / allowed`, compared exactly. An `allowed` of zero is infinite unless `used` is too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ratio {
    pub used: u64,
    pub allowed: u64,
}

impl Ratio {
    /// Parts per million, rounded up, so it passes 1,000,000 exactly when `used > allowed`.
    #[must_use]
    pub fn ppm(self) -> u64 {
        if self.allowed == 0 {
            return if self.used == 0 { 0 } else { u64::MAX };
        }
        let scaled = u128::from(self.used) * 1_000_000;
        u64::try_from(scaled.div_ceil(u128::from(self.allowed))).unwrap_or(u64::MAX)
    }
}

impl Ratio {
    /// Orders by value, so `1/2` and `2/4` compare equal.
    #[must_use]
    pub fn compare(self, other: Ratio) -> Ordering {
        match (self.is_infinite(), other.is_infinite()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                let (used, allowed) = self.finite();
                let (other_used, other_allowed) = other.finite();
                (used * other_allowed).cmp(&(other_used * allowed))
            }
        }
    }

    fn is_infinite(self) -> bool {
        self.allowed == 0 && self.used > 0
    }

    /// The ratio as a fraction with a non-zero denominator; `0/0` reads as `0/1`.
    fn finite(self) -> (u128, u128) {
        if self.allowed == 0 {
            (0, 1)
        } else {
            (u128::from(self.used), u128::from(self.allowed))
        }
    }
}

/// One limit as used against allowed; either side is `None` when it is unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Check {
    pub limit: Limit,
    pub used: Option<u64>,
    pub allowed: Option<u64>,
}

impl Check {
    #[must_use]
    pub fn ratio(&self) -> Option<Ratio> {
        Some(Ratio {
            used: self.used?,
            allowed: self.allowed?,
        })
    }

    /// Inclusive, as the node and the ledger compare: `used == allowed` fits.
    #[must_use]
    pub fn status(&self) -> Status {
        match self.ratio() {
            Some(ratio) if ratio.used <= ratio.allowed => Status::Ok,
            Some(_) => Status::Over,
            None => Status::NotApplicable,
        }
    }
}

/// The transaction as the network sees it: the contract's part, plus each term the
/// profile knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Effective {
    pub cost: Cost,
    pub nodes: u64,
    pub estimated_size: u64,
    pub time_to_dismiss: u64,
}

impl Effective {
    /// The proof term grows the estimated size and `blockUsage`. The balancing term's
    /// bytes grow the estimated size and its cost adds dimension-wise, both counted for
    /// the transaction's intents.
    #[must_use]
    pub fn of(
        measurement: &Measurement,
        balancing: Option<&BalancingTerm>,
        proof: Option<&ProofTerm>,
    ) -> Effective {
        let proof_bytes = proof.map_or(0, |term| term.bytes(measurement.proofs));
        let contract = Effective {
            cost: Cost {
                block_usage: measurement.cost.block_usage.saturating_add(proof_bytes),
                ..measurement.cost
            },
            nodes: u64::from(measurement.declared_nodes),
            estimated_size: measurement.estimated_size().saturating_add(proof_bytes),
            time_to_dismiss: measurement.time_to_dismiss,
        };
        match balancing {
            None => contract,
            Some(term) => Effective {
                cost: contract
                    .cost
                    .saturating_add(&term.added_cost(measurement.intents)),
                nodes: contract.nodes.saturating_add(u64::from(term.nodes)),
                estimated_size: contract
                    .estimated_size
                    .saturating_add(term.added_bytes(measurement.intents)),
                time_to_dismiss: contract
                    .time_to_dismiss
                    .saturating_add(term.cost.max_time()),
            },
        }
    }
}

/// What the proof term did to one evaluation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProofBytes {
    /// Added this many bytes to the ledger's estimate of an unproven transaction.
    Added(u64),
    /// Nothing: the transaction holds its proofs, so its sizes are real.
    Proven,
    /// Nothing: the profile does not know the term, so the sizes are the ledger's estimate.
    Unknown,
}

impl ProofBytes {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            ProofBytes::Added(_) => "added",
            ProofBytes::Proven => "proven",
            ProofBytes::Unknown => "unknown",
        }
    }

    /// The bytes added, when any were.
    #[must_use]
    pub fn added(self) -> Option<u64> {
        match self {
            ProofBytes::Added(bytes) => Some(bytes),
            ProofBytes::Proven | ProofBytes::Unknown => None,
        }
    }
}

/// The node's gas for a cost: the largest dimension normalized to the block limits,
/// scaled and rounded up as `scale_normalized_cost` does, capped at the scale.
#[must_use]
pub fn scaled_cost(cost: &Cost, block_limits: &Cost, scale: u64) -> u64 {
    let largest = Dimension::ALL
        .into_iter()
        .map(|dimension| FixedPoint::from_u64_div(cost.get(dimension), block_limits.get(dimension)))
        .fold(FixedPoint::ZERO, Ord::max);
    let scaled = largest
        .into_atomic_units(u128::from(scale))
        .min(u128::from(scale));
    u64::try_from(scaled).unwrap_or(scale)
}

/// What an evaluation's numbers cover.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    /// The contract's transaction alone; the profile's balancing term is unknown.
    ContractOnly,
    /// The contract's transaction plus the profile's balancing term.
    Balanced,
    /// A transaction a wallet already balanced, as measured.
    AsSubmitted,
}

impl Scope {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Scope::ContractOnly => "contract-only",
            Scope::Balanced => "balanced",
            Scope::AsSubmitted => "as-submitted",
        }
    }

    /// The scope of an unbalanced transaction under `caps`.
    #[must_use]
    pub fn of(caps: &Caps) -> Scope {
        if caps.balancing.is_some() {
            Scope::Balanced
        } else {
            Scope::ContractOnly
        }
    }
}

/// Every limit for one transaction under one profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation {
    pub scope: Scope,
    pub proof: ProofBytes,
    /// Bytes the balancing term added; `None` unless `scope` is `balanced`.
    pub balancing: Option<u64>,
    pub effective: Effective,
    pub time_to_dismiss_allowed: u64,
    /// Scaled cost plus fixed extra weight, which the extrinsic ceiling reads.
    pub dispatch_weight: Option<u64>,
    /// Dispatch weight plus the base extrinsic weight, which the block total reads.
    pub weight: Option<u64>,
    /// One entry per [`Limit::ALL`], in that order.
    pub checks: Vec<Check>,
}

impl Evaluation {
    /// Whether no evaluable limit is exceeded. Limits marked `n/a` do not count.
    #[must_use]
    pub fn fits(&self) -> bool {
        self.checks
            .iter()
            .all(|check| check.status() != Status::Over)
    }

    /// The evaluable limit with the highest used/allowed ratio; ties go to the earlier one.
    #[must_use]
    pub fn binding(&self) -> Option<&Check> {
        self.checks
            .iter()
            .filter_map(|check| check.ratio().map(|ratio| (ratio, check)))
            .fold(
                None,
                |best: Option<(Ratio, &Check)>, (ratio, check)| match best {
                    Some((top, _)) if top.compare(ratio) != Ordering::Less => best,
                    _ => Some((ratio, check)),
                },
            )
            .map(|(_, check)| check)
    }

    #[must_use]
    pub fn check(&self, limit: Limit) -> Option<&Check> {
        self.checks.iter().find(|check| check.limit == limit)
    }
}

/// Evaluates every per-transaction limit of a transaction of `form`. A proven transaction
/// holds its proofs, so the proof term is not added; a balanced one also holds the fee
/// payment, so neither is the balancing term.
#[must_use]
pub fn evaluate_form(measurement: &Measurement, caps: &Caps, form: Form) -> Evaluation {
    match form {
        Form::Unproven => evaluate(measurement, caps),
        Form::Proven => Evaluation {
            proof: ProofBytes::Proven,
            ..evaluate(
                measurement,
                &Caps {
                    proof: None,
                    ..*caps
                },
            )
        },
        Form::Balanced => Evaluation {
            scope: Scope::AsSubmitted,
            proof: ProofBytes::Proven,
            ..evaluate(
                measurement,
                &Caps {
                    balancing: None,
                    proof: None,
                    ..*caps
                },
            )
        },
    }
}

/// Evaluates every per-transaction limit of an unproven, unbalanced transaction.
#[must_use]
pub fn evaluate(measurement: &Measurement, caps: &Caps) -> Evaluation {
    let effective = Effective::of(measurement, caps.balancing.as_ref(), caps.proof.as_ref());
    let time_to_dismiss_allowed = caps.time_to_dismiss_allowed(effective.estimated_size);
    let dispatch_weight = caps.dispatch_weight(&effective.cost);
    let weight = caps.block_weight(&effective.cost);
    let dimension = |dimension: Dimension| {
        (
            Some(effective.cost.get(dimension)),
            Some(caps.block_limits.get(dimension)),
        )
    };
    let checks = Limit::ALL
        .into_iter()
        .map(|limit| {
            let (used, allowed) = match limit {
                Limit::Nodes => (Some(effective.nodes), caps.max_transaction_nodes),
                Limit::TxBytes => (
                    Some(effective.estimated_size),
                    Some(caps.transaction_byte_limit),
                ),
                Limit::ReadTime => dimension(Dimension::ReadTime),
                Limit::ComputeTime => dimension(Dimension::ComputeTime),
                Limit::BlockUsage => dimension(Dimension::BlockUsage),
                Limit::BytesWritten => dimension(Dimension::BytesWritten),
                Limit::BytesChurned => dimension(Dimension::BytesChurned),
                Limit::TimeToDismiss => (
                    Some(effective.time_to_dismiss),
                    Some(time_to_dismiss_allowed),
                ),
                Limit::ExtrinsicWeight => (dispatch_weight, caps.extrinsic_weight_ceiling),
                Limit::BlockWeight => (weight, caps.normal_block_weight),
                Limit::BlockLength => (Some(effective.estimated_size), caps.normal_block_length),
            };
            Check {
                limit,
                used,
                allowed,
            }
        })
        .collect();
    Evaluation {
        scope: Scope::of(caps),
        proof: caps.proof.map_or(ProofBytes::Unknown, |term| {
            ProofBytes::Added(term.bytes(measurement.proofs))
        }),
        balancing: caps
            .balancing
            .map(|term| term.added_bytes(measurement.intents)),
        effective,
        time_to_dismiss_allowed,
        dispatch_weight,
        weight,
        checks,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cost::Proofs;

    /// The wallet's fee payment, as measured on node 2.1.101 (conservative end).
    pub(crate) fn balancing() -> BalancingTerm {
        BalancingTerm {
            nodes: 10,
            bytes: 3_283,
            further_intent_bytes: 65,
            cost: Cost {
                read_time: 1_870_000_000,
                compute_time: 3_433_722_316,
                block_usage: 3_283,
                bytes_written: 224,
                bytes_churned: 9_288,
            },
        }
    }

    /// What proving adds, as measured on node 2.1.101 (conservative end).
    pub(crate) fn proof_term() -> ProofTerm {
        ProofTerm {
            call_bytes: 564,
            builtin_bytes: 2,
        }
    }

    /// The 2.1.101 mainnet caps, written out so the arithmetic is visible.
    pub(crate) fn mainnet_caps() -> Caps {
        Caps {
            transaction_byte_limit: 1_048_576,
            time_to_dismiss_per_byte: 2_000_000,
            min_time_to_dismiss: 15_000_000_000,
            block_limits: Cost {
                read_time: 2_000_000_000_000,
                compute_time: 2_000_000_000_000,
                block_usage: 1_000_000,
                bytes_written: 50_000,
                bytes_churned: 50_000_000,
            },
            max_transaction_nodes: Some(1024),
            weight_scale: Some(2_000_000_000_000),
            fixed_extra_weight: Some(20_000_000_000),
            base_extrinsic_weight: Some(108_157_000),
            extrinsic_weight_ceiling: Some(1_299_891_843_000),
            normal_block_weight: Some(1_500_000_000_000),
            normal_block_length: Some(786_432),
            balancing: Some(balancing()),
            proof: Some(proof_term()),
        }
    }

    /// The mainnet caps without the balancing term.
    pub(crate) fn contract_caps() -> Caps {
        Caps {
            balancing: None,
            ..mainnet_caps()
        }
    }

    /// The mainnet caps without either term: the ledger's estimate as it stands.
    pub(crate) fn estimate_caps() -> Caps {
        Caps {
            balancing: None,
            proof: None,
            ..mainnet_caps()
        }
    }

    /// The single base mint, as the ledger measures it unproven.
    pub(crate) fn base_mint() -> Measurement {
        Measurement {
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
            proofs: Proofs {
                calls: 1,
                builtin: 1,
            },
            intents: 1,
        }
    }

    /// The base mint as a wallet submitted it on node 2.1.101.
    fn balanced_base_mint() -> Measurement {
        Measurement {
            cost: Cost {
                read_time: 5_848_000_000,
                compute_time: 11_836_578_891,
                block_usage: 14_813,
                bytes_written: 384,
                bytes_churned: 23_248,
            },
            serialized_len: 14_881,
            declared_nodes: 98,
            time_to_dismiss: 11_858_176_616,
            proofs: Proofs {
                calls: 1,
                builtin: 2,
            },
            intents: 2,
        }
    }

    #[test]
    fn caps_of_mainnet_match_the_written_out_caps() {
        let profile = Profile::embedded("mainnet").expect("mainnet parses");
        assert_eq!(Caps::of(&profile), mainnet_caps());
    }

    #[test]
    fn the_contract_only_base_mint_binds_on_time_to_dismiss() {
        let evaluation = evaluate(&base_mint(), &contract_caps());
        assert!(evaluation.fits());
        assert_eq!(evaluation.proof, ProofBytes::Added(566));
        let binding = evaluation.binding().expect("some limit is evaluable");
        assert_eq!(binding.limit, Limit::TimeToDismiss);
        assert_eq!(binding.allowed, Some(23_098_000_000));
        assert_eq!(binding.ratio().map(Ratio::ppm), Some(364_727));
    }

    #[test]
    fn without_the_proof_term_the_limits_read_the_ledger_estimate() {
        let evaluation = evaluate(&base_mint(), &estimate_caps());
        assert_eq!(evaluation.proof, ProofBytes::Unknown);
        assert_eq!(evaluation.effective.estimated_size, 10_983);
        let binding = evaluation.binding().expect("some limit is evaluable");
        assert_eq!(binding.limit, Limit::TimeToDismiss);
        assert_eq!(binding.allowed, Some(21_966_000_000));
        assert_eq!(binding.ratio().map(Ratio::ppm), Some(383_523));
    }

    #[test]
    fn the_node_gas_and_block_weight_of_submitted_mints_reproduce() {
        let caps = contract_caps();
        let limits = caps.block_limits;
        let scale = 2_000_000_000_000;
        // get_transaction_cost on node 2.1.101, then the block's Normal weight.
        let base = balanced_base_mint();
        assert_eq!(scaled_cost(&base.cost, &limits, scale), 29_626_000_001);
        assert_eq!(caps.block_weight(&base.cost), Some(49_734_157_001));
        let preset = Cost {
            read_time: 7_276_000_000,
            compute_time: 14_049_186_550,
            block_usage: 15_194,
            bytes_written: 561,
            bytes_churned: 23_818,
        };
        assert_eq!(scaled_cost(&preset, &limits, scale), 30_388_000_001);
        assert_eq!(caps.block_weight(&preset), Some(50_496_157_001));
        let merged_40 = Cost {
            read_time: 124_525_000_000,
            compute_time: 319_759_298_024,
            block_usage: 444_822,
            bytes_written: 6_624,
            bytes_churned: 567_688,
        };
        assert_eq!(scaled_cost(&merged_40, &limits, scale), 889_644_000_001);
    }

    #[test]
    fn the_ceiling_reads_the_dispatch_weight_and_the_block_adds_the_base() {
        let evaluation = evaluate_form(&balanced_base_mint(), &mainnet_caps(), Form::Balanced);
        assert_eq!(evaluation.dispatch_weight, Some(49_626_000_001));
        assert_eq!(evaluation.weight, Some(49_734_157_001));
        let used = |limit| evaluation.check(limit).and_then(|check| check.used);
        assert_eq!(used(Limit::ExtrinsicWeight), Some(49_626_000_001));
        assert_eq!(used(Limit::BlockWeight), Some(49_734_157_001));
    }

    #[test]
    fn the_proof_and_balancing_terms_cover_the_submitted_mint() {
        // The submitted mint measured 14,813 bytes and weighed 49,734,157,001.
        let evaluation = evaluate(&base_mint(), &mainnet_caps());
        assert_eq!(evaluation.effective.estimated_size, 14_832);
        assert_eq!(evaluation.weight, Some(49_772_157_001));
        assert_eq!(
            evaluation.effective.time_to_dismiss,
            balanced_base_mint().time_to_dismiss
        );
    }

    #[test]
    fn a_balanced_transaction_is_evaluated_as_submitted() {
        let evaluation = evaluate_form(&balanced_base_mint(), &mainnet_caps(), Form::Balanced);
        assert_eq!(evaluation.scope, Scope::AsSubmitted);
        assert_eq!(evaluation.proof, ProofBytes::Proven);
        assert_eq!(evaluation.balancing, None);
        assert_eq!(evaluation.effective.nodes, 98);
        assert_eq!(evaluation.effective.estimated_size, 14_813);
        assert_eq!(evaluation.weight, Some(49_734_157_001));
    }

    #[test]
    fn a_proven_transaction_gets_the_balancing_term_but_not_the_proof_term() {
        let proven = evaluate_form(&base_mint(), &mainnet_caps(), Form::Proven);
        assert_eq!(proven.scope, Scope::Balanced);
        assert_eq!(proven.proof, ProofBytes::Proven);
        assert_eq!(proven.balancing, Some(3_283));
        assert_eq!(proven.effective.nodes, 99);
        assert_eq!(proven.effective.estimated_size, 10_983 + 3_283);
    }

    #[test]
    fn the_proof_term_adds_to_the_size_and_block_usage_only() {
        let effective = Effective::of(&base_mint(), None, Some(&proof_term()));
        assert_eq!(effective.estimated_size, 11_549);
        assert_eq!(
            effective.cost,
            Cost {
                block_usage: 11_549,
                ..base_mint().cost
            }
        );
        assert_eq!(effective.nodes, 89);
        assert_eq!(effective.time_to_dismiss, base_mint().time_to_dismiss);
    }

    #[test]
    fn the_proof_term_counts_each_proof_by_kind() {
        let term = proof_term();
        let bytes = |calls, builtin| term.bytes(Proofs { calls, builtin });
        assert_eq!(bytes(1, 0), 564);
        assert_eq!(bytes(1, 4), 572);
        assert_eq!(bytes(40, 40), 22_640);
    }

    fn live(name: &str) -> Measurement {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/live")
            .join(name);
        let bytes = std::fs::read(path).expect("the fixture exists");
        let params = Profile::embedded("mainnet")
            .expect("mainnet parses")
            .parameters;
        crate::tx::measure(&bytes, &params).expect("it measures").1
    }

    #[test]
    fn the_shipped_proof_term_reaches_each_captured_proven_size_within_3_bytes() {
        let term = Profile::embedded("mainnet")
            .expect("mainnet parses")
            .proof
            .expect("mainnet knows the proof term");
        // The last three proven sizes are recorded in tests/fixtures/README.md, under `live/`.
        let cases = [
            (
                "base-mint-unproven.bin",
                live("base-mint-proven.bin").estimated_size(),
            ),
            (
                "preset-merged-n2-unproven.bin",
                live("preset-merged-n2-proven.bin").estimated_size(),
            ),
            ("base-merged-n40-unproven.bin", 439_050),
            ("base-merged-n41-unproven.bin", 449_999),
            ("preset-merged-n30-unproven.bin", 332_782),
        ];
        for (name, proven) in cases {
            let unproven = live(name);
            assert!(unproven.estimated_size() < proven, "{name}");
            let estimated = Effective::of(&unproven, None, Some(&term)).estimated_size;
            assert!(
                (proven..=proven + 3).contains(&estimated),
                "{name}: {estimated} against {proven}"
            );
        }
    }

    /// The balanced sizes are the `blockUsage` of the wallet-balanced builds. Only the single
    /// mint's file is kept. The others are recorded in `tests/fixtures/README.md`, under `live/`.
    #[test]
    fn the_shipped_terms_reach_each_captured_balanced_size_without_undercounting() {
        let caps = Caps::of(&Profile::embedded("mainnet").expect("mainnet parses"));
        let cases = [
            (
                "base-mint-unproven.bin",
                live("base-mint-balanced.bin").estimated_size(),
            ),
            ("preset-merged-n2-unproven.bin", 26_379),
            ("base-merged-n40-unproven.bin", 444_822),
            ("base-merged-n41-unproven.bin", 455_859),
            ("preset-merged-n30-unproven.bin", 337_910),
        ];
        for (name, balanced) in cases {
            let estimated = evaluate(&live(name), &caps).effective.estimated_size;
            assert!(
                (balanced..=balanced + 50).contains(&estimated),
                "{name}: {estimated} against {balanced}"
            );
        }
    }

    #[test]
    fn each_further_intent_adds_to_the_size_and_block_usage_only() {
        let merged = Measurement {
            intents: 40,
            ..base_mint()
        };
        let one = Effective::of(&base_mint(), Some(&balancing()), None);
        let forty = Effective::of(&merged, Some(&balancing()), None);
        assert_eq!(forty.estimated_size, one.estimated_size + 39 * 65);
        assert_eq!(
            forty.cost,
            Cost {
                block_usage: one.cost.block_usage + 39 * 65,
                ..one.cost
            }
        );
        assert_eq!(forty.nodes, one.nodes);
        assert_eq!(forty.time_to_dismiss, one.time_to_dismiss);
        let evaluation = evaluate(&merged, &mainnet_caps());
        assert_eq!(evaluation.balancing, Some(3_283 + 39 * 65));
    }

    #[test]
    fn an_unknown_base_leaves_the_ceiling_but_not_the_block_weight() {
        let caps = Caps {
            base_extrinsic_weight: None,
            ..contract_caps()
        };
        let evaluation = evaluate(&base_mint(), &caps);
        assert_eq!(evaluation.weight, None);
        let status = |limit| evaluation.check(limit).map(Check::status);
        assert_eq!(status(Limit::ExtrinsicWeight), Some(Status::Ok));
        assert_eq!(status(Limit::BlockWeight), Some(Status::NotApplicable));
    }

    #[test]
    fn an_unknown_weight_scale_leaves_every_weight_limit_not_applicable() {
        let caps = Caps {
            weight_scale: None,
            ..contract_caps()
        };
        let evaluation = evaluate(&base_mint(), &caps);
        assert_eq!(evaluation.dispatch_weight, None);
        assert_eq!(evaluation.weight, None);
        let status = |limit| evaluation.check(limit).map(Check::status);
        assert_eq!(status(Limit::ExtrinsicWeight), Some(Status::NotApplicable));
        assert_eq!(status(Limit::BlockWeight), Some(Status::NotApplicable));
        assert_eq!(
            evaluation.binding().map(|check| check.limit),
            Some(Limit::TimeToDismiss)
        );
    }

    #[test]
    fn declared_nodes_at_the_cap_fit_and_one_more_does_not() {
        let at_cap = Measurement {
            declared_nodes: 1014,
            ..base_mint()
        };
        let over = Measurement {
            declared_nodes: 1015,
            ..base_mint()
        };
        assert!(evaluate(&at_cap, &mainnet_caps()).fits());
        let evaluation = evaluate(&over, &mainnet_caps());
        assert!(!evaluation.fits());
        assert_eq!(
            evaluation.binding().map(|check| check.limit),
            Some(Limit::Nodes)
        );
    }

    #[test]
    fn time_to_dismiss_allowed_is_the_larger_of_per_byte_and_minimum() {
        let caps = mainnet_caps();
        assert_eq!(caps.time_to_dismiss_allowed(10_983), 21_966_000_000);
        assert_eq!(caps.time_to_dismiss_allowed(1_000), 15_000_000_000);
    }

    #[test]
    fn the_balancing_term_adds_to_every_side_it_touches() {
        let effective = Effective::of(&base_mint(), Some(&balancing()), None);
        assert_eq!(effective.nodes, 99);
        assert_eq!(effective.estimated_size, 14_266);
        assert_eq!(effective.cost.block_usage, 14_266);
        assert_eq!(effective.cost.compute_time, 11_836_578_891);
        assert_eq!(effective.time_to_dismiss, 11_858_176_616);
    }

    #[test]
    fn scaled_cost_caps_at_the_scale_when_a_dimension_passes_the_block() {
        let limits = mainnet_caps().block_limits;
        let over = Cost {
            block_usage: 2_000_000,
            ..base_mint().cost
        };
        assert_eq!(scaled_cost(&over, &limits, 100), 100);
    }

    #[test]
    fn ratio_ppm_rounds_up_and_passes_a_million_only_when_over() {
        assert_eq!(
            Ratio {
                used: 1,
                allowed: 3
            }
            .ppm(),
            333_334
        );
        assert_eq!(
            Ratio {
                used: 3,
                allowed: 3
            }
            .ppm(),
            1_000_000
        );
        assert_eq!(
            Ratio {
                used: 1_000_001,
                allowed: 1_000_000
            }
            .ppm(),
            1_000_001
        );
        assert_eq!(
            Ratio {
                used: 0,
                allowed: 0
            }
            .ppm(),
            0
        );
        assert_eq!(
            Ratio {
                used: 1,
                allowed: 0
            }
            .ppm(),
            u64::MAX
        );
    }

    #[test]
    fn ratios_compare_exactly() {
        let ratio = |used, allowed| Ratio { used, allowed };
        assert_eq!(
            ratio(1, 3).compare(ratio(333_333, 1_000_000)),
            Ordering::Greater
        );
        assert_eq!(ratio(1, 0).compare(ratio(5, 1)), Ordering::Greater);
        assert_eq!(ratio(5, 1).compare(ratio(1, 0)), Ordering::Less);
        assert_eq!(ratio(0, 0).compare(ratio(1, 9)), Ordering::Less);
        assert_eq!(ratio(0, 0).compare(ratio(0, 9)), Ordering::Equal);
        assert_eq!(ratio(2, 4).compare(ratio(1, 2)), Ordering::Equal);
    }
}
