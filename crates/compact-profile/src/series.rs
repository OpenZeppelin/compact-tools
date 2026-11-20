//! Size series: scenarios sharing a series name, fitted once and bounded per network.

use serde::{Deserialize, Serialize};

use crate::cost::{Dimension, Measurement};
use crate::fit::{Largest, Line, largest};
use crate::limits::{Caps, Limit};

/// A measured quantity a series fits a line to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    Cost(Dimension),
    Nodes,
    SerializedLen,
    TimeToDismiss,
}

impl Metric {
    pub const ALL: [Metric; 8] = [
        Metric::Cost(Dimension::ReadTime),
        Metric::Cost(Dimension::ComputeTime),
        Metric::Cost(Dimension::BlockUsage),
        Metric::Cost(Dimension::BytesWritten),
        Metric::Cost(Dimension::BytesChurned),
        Metric::Nodes,
        Metric::SerializedLen,
        Metric::TimeToDismiss,
    ];

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Metric::Cost(dimension) => dimension.name(),
            Metric::Nodes => "nodes",
            Metric::SerializedLen => "serializedLen",
            Metric::TimeToDismiss => "timeToDismiss",
        }
    }

    fn read(self, measurement: &Measurement) -> u64 {
        match self {
            Metric::Cost(dimension) => measurement.cost.get(dimension),
            Metric::Nodes => u64::from(measurement.declared_nodes),
            Metric::SerializedLen => measurement.serialized_len,
            Metric::TimeToDismiss => measurement.time_to_dismiss,
        }
    }
}

/// One series member: its size, its measurement, and its verdict on one network.
#[derive(Clone, Copy, Debug)]
pub struct Point<'a> {
    pub n: u64,
    pub measurement: &'a Measurement,
    pub fits: bool,
    /// The limit with the highest ratio, which for a member that does not fit is the
    /// one it exceeds most.
    pub binding: Option<Limit>,
}

/// The lines of one series, one per [`Metric::ALL`]; empty with fewer than two sizes.
#[derive(Clone, Debug, PartialEq)]
pub struct SeriesFit {
    pub sizes: Vec<u64>,
    pub lines: Vec<(Metric, Line)>,
}

impl SeriesFit {
    /// Fits every metric over `(n, measurement)` pairs.
    #[must_use]
    pub fn of(points: &[(u64, &Measurement)]) -> SeriesFit {
        let mut sizes: Vec<u64> = points.iter().map(|(n, _)| *n).collect();
        sizes.sort_unstable();
        let lines = Metric::ALL
            .into_iter()
            .filter_map(|metric| {
                let values: Vec<(u64, u64)> = points
                    .iter()
                    .map(|(n, measurement)| (*n, metric.read(measurement)))
                    .collect();
                Line::fit(&values).map(|line| (metric, line))
            })
            .collect();
        SeriesFit { sizes, lines }
    }

    #[must_use]
    pub fn line(&self, metric: Metric) -> Option<Line> {
        self.lines
            .iter()
            .find(|(candidate, _)| *candidate == metric)
            .map(|(_, line)| *line)
    }
}

/// Where a series' reported maximum comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Basis {
    /// Sizes on both sides of a limit were measured.
    Measured,
    /// No measured boundary; the fitted lines predict it.
    Fit,
    /// Neither: a single size and no boundary.
    None,
}

/// The largest fitting and smallest failing measured sizes, adjacent in the series.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Boundary {
    pub largest_fit: u64,
    pub smallest_over: u64,
    /// The limit the smallest failing size exceeds most.
    pub binding: Option<Limit>,
}

/// One series on one network.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeriesCapacity {
    /// The fit's largest size per limit, one entry per [`Limit::ALL`]; `None` is `n/a`.
    pub predictions: Vec<(Limit, Option<Largest>)>,
    pub boundary: Option<Boundary>,
    /// The reported maximum: the measured boundary when there is one, else the fit's.
    pub max_n: Option<Largest>,
    pub basis: Basis,
    pub binding: Option<Limit>,
}

impl SeriesCapacity {
    /// The fit's smallest prediction and the limit behind it; ties go to the earlier limit.
    #[must_use]
    pub fn predicted(&self) -> Option<(Largest, Limit)> {
        self.predictions
            .iter()
            .filter_map(|(limit, prediction)| prediction.map(|largest| (largest, *limit)))
            .fold(None, |best, (candidate, limit)| match best {
                Some((top, _)) if top.min(candidate) == top => best,
                _ => Some((candidate, limit)),
            })
    }
}

/// Bounds one series on one network. `points` must be sorted by size.
#[must_use]
pub fn capacity(fit: &SeriesFit, points: &[Point<'_>], caps: &Caps) -> SeriesCapacity {
    let predictions: Vec<(Limit, Option<Largest>)> = Limit::ALL
        .into_iter()
        .map(|limit| (limit, predict(fit, caps, limit)))
        .collect();
    let boundary = boundary(points);
    let mut capacity = SeriesCapacity {
        predictions,
        boundary,
        max_n: None,
        basis: Basis::None,
        binding: None,
    };
    if let Some(boundary) = boundary {
        capacity.max_n = Some(Largest::Max(boundary.largest_fit));
        capacity.basis = Basis::Measured;
        capacity.binding = boundary.binding;
    } else if let Some((largest, limit)) = capacity.predicted() {
        capacity.max_n = Some(largest);
        capacity.basis = Basis::Fit;
        capacity.binding = (largest != Largest::Unbounded).then_some(limit);
    }
    capacity
}

/// The first failing size, and the largest fitting size below it.
fn boundary(points: &[Point<'_>]) -> Option<Boundary> {
    let over = points.iter().find(|point| !point.fits)?;
    let fit = points
        .iter()
        .filter(|point| point.n < over.n && point.fits)
        .max_by_key(|point| point.n)?;
    Some(Boundary {
        largest_fit: fit.n,
        smallest_over: over.n,
        binding: over.binding,
    })
}

#[allow(
    clippy::cast_precision_loss,
    reason = "caps and balancing terms stay far below 2^52"
)]
fn predict(fit: &SeriesFit, caps: &Caps, limit: Limit) -> Option<Largest> {
    let balancing = caps.balancing.as_ref();
    let extra_bytes = balancing.map_or(0.0, |term| term.bytes as f64);
    let size = fit
        .line(Metric::Cost(Dimension::BlockUsage))?
        .shifted(extra_bytes);
    let dimension_line = |dimension: Dimension| {
        fit.line(Metric::Cost(dimension))
            .map(|line| line.shifted(balancing.map_or(0.0, |term| term.cost.get(dimension) as f64)))
    };
    // Weight stays within `cap` while every dimension stays within its share of what the
    // cap leaves after the per-transaction constants.
    let weight_within = |cap: u64, constant: u64| -> Option<Largest> {
        let scale = caps.weight_scale? as f64;
        let room = cap.saturating_sub(constant) as f64;
        Dimension::ALL
            .into_iter()
            .map(|dimension| {
                let allowed = room * caps.block_limits.get(dimension) as f64 / scale;
                dimension_line(dimension).map(|line| largest(line, allowed))
            })
            .try_fold(Largest::Unbounded, |all, one| one.map(|one| all.min(one)))
    };
    let within_block = |dimension: Dimension| {
        Some(largest(
            dimension_line(dimension)?,
            caps.block_limits.get(dimension) as f64,
        ))
    };
    match limit {
        Limit::Nodes => {
            let nodes = fit
                .line(Metric::Nodes)?
                .shifted(balancing.map_or(0.0, |term| f64::from(term.nodes)));
            Some(largest(nodes, caps.max_transaction_nodes? as f64))
        }
        Limit::TxBytes => Some(largest(size, caps.transaction_byte_limit as f64)),
        Limit::ReadTime => within_block(Dimension::ReadTime),
        Limit::ComputeTime => within_block(Dimension::ComputeTime),
        Limit::BlockUsage => within_block(Dimension::BlockUsage),
        Limit::BytesWritten => within_block(Dimension::BytesWritten),
        Limit::BytesChurned => within_block(Dimension::BytesChurned),
        Limit::TimeToDismiss => {
            let used = fit
                .line(Metric::TimeToDismiss)?
                .shifted(balancing.map_or(0.0, |term| term.cost.max_time() as f64));
            let per_byte = caps.time_to_dismiss_per_byte as f64;
            // Allowed is max(per_byte * size, min): within either term is within the max.
            let against_size = Line {
                fixed: used.fixed - per_byte * size.fixed,
                per_item: used.per_item - per_byte * size.per_item,
                max_residual: used.max_residual,
            };
            Some(largest(against_size, 0.0).max(largest(used, caps.min_time_to_dismiss as f64)))
        }
        Limit::ExtrinsicWeight => {
            weight_within(caps.extrinsic_weight_ceiling?, caps.fixed_extra_weight?)
        }
        Limit::BlockWeight => weight_within(
            caps.normal_block_weight?,
            caps.fixed_extra_weight?
                .saturating_add(caps.base_extrinsic_weight?),
        ),
        Limit::BlockLength => Some(largest(size, caps.normal_block_length? as f64)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::Cost;
    use crate::limits::evaluate;
    use crate::limits::tests::{base_mint, mainnet_caps};

    fn merged(n: u64, nodes: u32) -> Measurement {
        let calls = |per_call: u64, fixed: u64| fixed + per_call * n;
        Measurement {
            cost: Cost {
                read_time: calls(3_043_000_000, 935_000_000),
                compute_time: calls(7_895_454_336, 507_402_238),
                block_usage: calls(10_398, 584),
                bytes_written: calls(160, 0),
                bytes_churned: calls(13_960, 0),
            },
            serialized_len: calls(1_724, 656),
            declared_nodes: nodes,
            time_to_dismiss: calls(7_900_000_000, 500_000_000),
        }
    }

    fn points<'a>(series: &'a [(u64, Measurement)], caps: &Caps) -> Vec<Point<'a>> {
        series
            .iter()
            .map(|(n, measurement)| {
                let evaluation = evaluate(measurement, caps);
                Point {
                    n: *n,
                    measurement,
                    fits: evaluation.fits(),
                    binding: evaluation.binding().map(|check| check.limit),
                }
            })
            .collect()
    }

    fn series() -> Vec<(u64, Measurement)> {
        [
            (1, 89),
            (2, 114),
            (4, 161),
            (8, 254),
            (16, 440),
            (32, 814),
            (40, 1002),
            (48, 1189),
        ]
        .into_iter()
        .map(|(n, nodes)| (n, merged(n, nodes)))
        .collect()
    }

    #[test]
    fn a_series_straddling_the_node_cap_reports_the_measured_boundary() {
        let caps = mainnet_caps();
        let series = series();
        let fit = SeriesFit::of(&series.iter().map(|(n, m)| (*n, m)).collect::<Vec<_>>());
        let capacity = capacity(&fit, &points(&series, &caps), &caps);
        assert_eq!(
            capacity.boundary,
            Some(Boundary {
                largest_fit: 40,
                smallest_over: 48,
                binding: Some(Limit::Nodes),
            })
        );
        assert_eq!(capacity.max_n, Some(Largest::Max(40)));
        assert_eq!(capacity.basis, Basis::Measured);
        assert_eq!(capacity.binding, Some(Limit::Nodes));
        assert_eq!(capacity.predicted(), Some((Largest::Max(40), Limit::Nodes)));
    }

    #[test]
    fn without_a_failing_size_the_fit_predicts_the_maximum() {
        let caps = mainnet_caps();
        let series: Vec<_> = series().into_iter().take(4).collect();
        let fit = SeriesFit::of(&series.iter().map(|(n, m)| (*n, m)).collect::<Vec<_>>());
        let capacity = capacity(&fit, &points(&series, &caps), &caps);
        assert_eq!(capacity.boundary, None);
        assert_eq!(capacity.basis, Basis::Fit);
        assert_eq!(capacity.binding, Some(Limit::Nodes));
    }

    #[test]
    fn an_unknown_cap_leaves_its_prediction_not_applicable() {
        let caps = Caps {
            max_transaction_nodes: None,
            ..mainnet_caps()
        };
        let series = series();
        let fit = SeriesFit::of(&series.iter().map(|(n, m)| (*n, m)).collect::<Vec<_>>());
        let capacity = capacity(&fit, &points(&series, &caps), &caps);
        let nodes = capacity
            .predictions
            .iter()
            .find(|(limit, _)| *limit == Limit::Nodes)
            .map(|(_, prediction)| *prediction);
        assert_eq!(nodes, Some(None));
        assert_eq!(capacity.boundary, None);
        assert_eq!(capacity.basis, Basis::Fit);
        assert_ne!(capacity.binding, Some(Limit::Nodes));
    }

    #[test]
    fn a_single_size_has_no_maximum() {
        let caps = mainnet_caps();
        let single = [(1, base_mint())];
        let fit = SeriesFit::of(&[(1, &single[0].1)]);
        let capacity = capacity(&fit, &points(&single, &caps), &caps);
        assert!(fit.lines.is_empty());
        assert_eq!(capacity.max_n, None);
        assert_eq!(capacity.basis, Basis::None);
    }

    #[test]
    fn block_weight_prediction_divides_the_cap_among_the_dimensions() {
        let caps = mainnet_caps();
        let series = series();
        let fit = SeriesFit::of(&series.iter().map(|(n, m)| (*n, m)).collect::<Vec<_>>());
        // (1.5e12 - 20e9 - 108,157,000) / 2e12 of a block is 739,945.9 block-usage bytes,
        // at 10,398 per call plus 584 + 3,283 fixed.
        assert_eq!(
            predict(&fit, &caps, Limit::BlockWeight),
            Some(Largest::Max(70))
        );
        // The ceiling leaves (1,299,891,843,000 - 20e9) / 2e12 of a block: 639,945.9 bytes.
        assert_eq!(
            predict(&fit, &caps, Limit::ExtrinsicWeight),
            Some(Largest::Max(61))
        );
    }
}
