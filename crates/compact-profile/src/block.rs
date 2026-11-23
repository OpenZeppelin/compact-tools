//! How many copies of one transaction fit in a block.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::cost::Dimension;
use crate::limits::{Caps, Evaluation, Limit};

/// Whether two copies of a transaction can land in the same block.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Conflict {
    #[default]
    None,
    /// The second copy's transcript no longer holds once the first applies.
    Serial,
}

/// One bound on transactions per block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Count {
    /// The bound reads an unknown profile field.
    NotApplicable,
    /// The transaction uses none of this resource.
    Unbounded,
    Txs(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bound {
    pub limit: Limit,
    pub count: Count,
}

/// What caps the per-block count: a limit, or the conflict class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Binding {
    Limit(Limit),
    Serial,
}

impl Binding {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Binding::Limit(limit) => limit.name(),
            Binding::Serial => "serial",
        }
    }
}

impl fmt::Display for Binding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

/// Transactions and logical operations per block for one scenario under one profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capacity {
    /// `blockWeight`, `blockLength`, then the five cumulative ledger block limits.
    pub bounds: Vec<Bound>,
    /// `None` when no bound can be evaluated.
    pub txs: Option<u64>,
    pub binding: Option<Binding>,
    pub ops: Option<u64>,
}

/// The per-block count: the smallest evaluable bound, 1 for a serial transaction, and 0
/// for one that fails a per-transaction limit.
#[must_use]
pub fn capacity(evaluation: &Evaluation, caps: &Caps, conflict: Conflict, ops: u32) -> Capacity {
    let effective = &evaluation.effective;
    let mut bounds = vec![
        Bound {
            limit: Limit::BlockWeight,
            count: per_block(caps.normal_block_weight, evaluation.weight),
        },
        Bound {
            limit: Limit::BlockLength,
            count: per_block(caps.normal_block_length, Some(effective.estimated_size)),
        },
    ];
    bounds.extend(Dimension::ALL.into_iter().map(|dimension| Bound {
        limit: Limit::of(dimension),
        count: per_block(
            Some(caps.block_limits.get(dimension)),
            Some(effective.cost.get(dimension)),
        ),
    }));

    let smallest = bounds
        .iter()
        .filter_map(|bound| match bound.count {
            Count::Txs(txs) => Some((txs, bound.limit)),
            Count::NotApplicable | Count::Unbounded => None,
        })
        .fold(
            None,
            |best: Option<(u64, Limit)>, (txs, limit)| match best {
                Some((top, _)) if top <= txs => best,
                _ => Some((txs, limit)),
            },
        );

    let (txs, binding) = if evaluation.fits() {
        match smallest {
            Some((txs, _)) if conflict == Conflict::Serial && txs > 1 => {
                (Some(1), Some(Binding::Serial))
            }
            Some((txs, limit)) => (Some(txs), Some(Binding::Limit(limit))),
            None => (None, None),
        }
    } else {
        let over = evaluation
            .binding()
            .map(|check| Binding::Limit(check.limit));
        (Some(0), over)
    };
    Capacity {
        bounds,
        txs,
        binding,
        ops: txs.map(|txs| txs.saturating_mul(u64::from(ops))),
    }
}

fn per_block(capacity: Option<u64>, per_tx: Option<u64>) -> Count {
    match (capacity, per_tx) {
        (Some(_), Some(0)) => Count::Unbounded,
        (Some(capacity), Some(per_tx)) => Count::Txs(capacity / per_tx),
        _ => Count::NotApplicable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::Measurement;
    use crate::limits::evaluate;
    use crate::limits::tests::{base_mint, contract_caps, mainnet_caps};

    fn count(capacity: &Capacity, limit: Limit) -> Count {
        capacity
            .bounds
            .iter()
            .find(|bound| bound.limit == limit)
            .map_or(Count::NotApplicable, |bound| bound.count)
    }

    #[test]
    fn balanced_base_mints_fill_a_block_at_30_as_node_2_1_101_did() {
        let caps = mainnet_caps();
        let capacity = capacity(&evaluate(&base_mint(), &caps), &caps, Conflict::None, 1);
        // 1.5e12 / 49,772,157,001 = 30.1; 786,432 / 14,832 = 53.0; 1e6 / 14,832 = 67.4.
        assert_eq!(count(&capacity, Limit::BlockWeight), Count::Txs(30));
        assert_eq!(count(&capacity, Limit::BlockLength), Count::Txs(53));
        assert_eq!(count(&capacity, Limit::BlockUsage), Count::Txs(67));
        assert_eq!(capacity.txs, Some(30));
        assert_eq!(capacity.binding, Some(Binding::Limit(Limit::BlockWeight)));
        assert_eq!(capacity.ops, Some(30));
    }

    #[test]
    fn without_the_proof_term_the_bounds_read_the_ledger_estimate() {
        let caps = Caps {
            proof: None,
            ..mainnet_caps()
        };
        let capacity = capacity(&evaluate(&base_mint(), &caps), &caps, Conflict::None, 1);
        // 1.5e12 / 48,640,157,001 = 30.8; 786,432 / 14,266 = 55.1; 1e6 / 14,266 = 70.1.
        assert_eq!(count(&capacity, Limit::BlockWeight), Count::Txs(30));
        assert_eq!(count(&capacity, Limit::BlockLength), Count::Txs(55));
        assert_eq!(count(&capacity, Limit::BlockUsage), Count::Txs(70));
    }

    #[test]
    fn the_contract_only_base_mint_counts_the_base_per_transaction() {
        let caps = contract_caps();
        let capacity = capacity(&evaluate(&base_mint(), &caps), &caps, Conflict::None, 1);
        // 1.5e12 / (43,098,000,001 + 108,157,000) = 34.7.
        assert_eq!(count(&capacity, Limit::BlockWeight), Count::Txs(34));
    }

    #[test]
    fn ops_per_block_multiply_by_ops_per_transaction() {
        let caps = mainnet_caps();
        let capacity = capacity(&evaluate(&base_mint(), &caps), &caps, Conflict::None, 4);
        assert_eq!(capacity.ops, Some(120));
    }

    #[test]
    fn a_serial_transaction_lands_once_per_block() {
        let caps = mainnet_caps();
        let capacity = capacity(&evaluate(&base_mint(), &caps), &caps, Conflict::Serial, 3);
        assert_eq!(capacity.txs, Some(1));
        assert_eq!(capacity.binding, Some(Binding::Serial));
        assert_eq!(capacity.ops, Some(3));
    }

    #[test]
    fn unknown_node_caps_leave_the_ledger_block_limits() {
        let caps = Caps {
            weight_scale: None,
            normal_block_length: None,
            ..mainnet_caps()
        };
        let capacity = capacity(&evaluate(&base_mint(), &caps), &caps, Conflict::None, 1);
        assert_eq!(count(&capacity, Limit::BlockWeight), Count::NotApplicable);
        assert_eq!(count(&capacity, Limit::BlockLength), Count::NotApplicable);
        assert_eq!(capacity.txs, Some(67));
        assert_eq!(capacity.binding, Some(Binding::Limit(Limit::BlockUsage)));
    }

    #[test]
    fn an_unused_dimension_does_not_bound() {
        let caps = contract_caps();
        let free = Measurement {
            cost: crate::cost::Cost {
                bytes_written: 0,
                ..base_mint().cost
            },
            ..base_mint()
        };
        let capacity = capacity(&evaluate(&free, &caps), &caps, Conflict::None, 1);
        assert_eq!(count(&capacity, Limit::BytesWritten), Count::Unbounded);
    }

    #[test]
    fn a_transaction_over_a_limit_fits_zero_times() {
        let caps = mainnet_caps();
        let over = Measurement {
            declared_nodes: 1015,
            ..base_mint()
        };
        let capacity = capacity(&evaluate(&over, &caps), &caps, Conflict::None, 41);
        assert_eq!(capacity.txs, Some(0));
        assert_eq!(capacity.binding, Some(Binding::Limit(Limit::Nodes)));
        assert_eq!(capacity.ops, Some(0));
    }
}
