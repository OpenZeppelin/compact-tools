//! Least-squares lines over a size series, and the largest size a line allows.

/// `fixed + per_item * n`, with the largest absolute residual over the fitted points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line {
    pub fixed: f64,
    pub per_item: f64,
    pub max_residual: f64,
}

impl Line {
    /// Ordinary least squares over `(n, value)`; `None` with fewer than two distinct sizes.
    #[must_use]
    #[allow(
        clippy::cast_precision_loss,
        reason = "sizes and measurements stay far below 2^52 in practice; the fit only proposes"
    )]
    pub fn fit(points: &[(u64, u64)]) -> Option<Line> {
        let count = points.len() as f64;
        let mean_n = points.iter().map(|(n, _)| *n as f64).sum::<f64>() / count;
        let mean_value = points.iter().map(|(_, value)| *value as f64).sum::<f64>() / count;
        let (spread, covariance) =
            points
                .iter()
                .fold((0.0, 0.0), |(spread, covariance), (n, value)| {
                    let dn = *n as f64 - mean_n;
                    (
                        spread + dn * dn,
                        covariance + dn * (*value as f64 - mean_value),
                    )
                });
        if points.is_empty() || spread == 0.0 {
            return None;
        }
        let per_item = covariance / spread;
        let fixed = mean_value - per_item * mean_n;
        let max_residual = points
            .iter()
            .map(|(n, value)| (*value as f64 - (fixed + per_item * *n as f64)).abs())
            .fold(0.0, f64::max);
        Some(Line {
            fixed,
            per_item,
            max_residual,
        })
    }

    /// The same line moved up by a constant, such as the balancing term's share.
    #[must_use]
    pub fn shifted(self, offset: f64) -> Line {
        Line {
            fixed: self.fixed + offset,
            ..self
        }
    }

    /// The sum of two lines over the same sizes; the residual bound adds.
    #[must_use]
    pub fn plus(self, other: Line) -> Line {
        Line {
            fixed: self.fixed + other.fixed,
            per_item: self.per_item + other.per_item,
            max_residual: self.max_residual + other.max_residual,
        }
    }
}

/// The largest size a limit allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Largest {
    /// The line never rises past the limit.
    Unbounded,
    /// The largest whole size within the limit; 0 when no positive size is.
    Max(u64),
}

impl Largest {
    #[must_use]
    pub fn min(self, other: Largest) -> Largest {
        match (self, other) {
            (Largest::Max(a), Largest::Max(b)) => Largest::Max(a.min(b)),
            (Largest::Max(a), Largest::Unbounded) | (Largest::Unbounded, Largest::Max(a)) => {
                Largest::Max(a)
            }
            (Largest::Unbounded, Largest::Unbounded) => Largest::Unbounded,
        }
    }

    #[must_use]
    pub fn max(self, other: Largest) -> Largest {
        match (self, other) {
            (Largest::Max(a), Largest::Max(b)) => Largest::Max(a.max(b)),
            _ => Largest::Unbounded,
        }
    }

    #[must_use]
    pub fn value(self) -> Option<u64> {
        match self {
            Largest::Max(n) => Some(n),
            Largest::Unbounded => None,
        }
    }
}

/// The largest whole `n >= 0` with `line(n) <= allowed`.
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the quotient is floored and checked non-negative; the cast saturates above u64"
)]
pub fn largest(line: Line, allowed: f64) -> Largest {
    if line.per_item <= 0.0 {
        return if line.fixed <= allowed {
            Largest::Unbounded
        } else {
            Largest::Max(0)
        };
    }
    let n = ((allowed - line.fixed) / line.per_item).floor();
    if n < 0.0 {
        Largest::Max(0)
    } else {
        Largest::Max(n as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exact_line_fits_with_no_residual() {
        let line = Line::fit(&[(1, 160), (2, 320), (4, 640), (8, 1280)]).expect("two sizes");
        assert!(line.fixed.abs() < 1e-9);
        assert!((line.per_item - 160.0).abs() < 1e-9);
        assert!(line.max_residual < 1e-9);
    }

    #[test]
    fn the_merged_node_counts_fit_about_23_per_call() {
        // Declared nodes of the base merge at 1, 2, 4, 8, 16, 32, 40 and 48 calls.
        let points = [
            (1, 89),
            (2, 114),
            (4, 161),
            (8, 254),
            (16, 440),
            (32, 814),
            (40, 1002),
            (48, 1189),
        ];
        let line = Line::fit(&points).expect("eight sizes");
        assert_eq!(format!("{:.2}", line.per_item), "23.38");
        assert_eq!(format!("{:.2}", line.fixed), "66.65");
        assert_eq!(format!("{:.2}", line.max_residual), "1.03");
        assert_eq!(largest(line, 1024.0), Largest::Max(40));
    }

    #[test]
    fn a_single_size_has_no_fit() {
        assert_eq!(Line::fit(&[(4, 10), (4, 12)]), None);
        assert_eq!(Line::fit(&[]), None);
    }

    #[test]
    fn largest_is_inclusive_at_the_limit() {
        let line = Line {
            fixed: 24.0,
            per_item: 25.0,
            max_residual: 0.0,
        };
        assert_eq!(largest(line, 1024.0), Largest::Max(40));
        assert_eq!(largest(line, 1023.0), Largest::Max(39));
    }

    #[test]
    fn a_flat_or_falling_line_is_unbounded_when_it_starts_inside() {
        let flat = Line {
            fixed: 10.0,
            per_item: 0.0,
            max_residual: 0.0,
        };
        assert_eq!(largest(flat, 20.0), Largest::Unbounded);
        assert_eq!(largest(flat, 5.0), Largest::Max(0));
    }

    #[test]
    fn a_line_starting_past_the_limit_allows_nothing() {
        let line = Line {
            fixed: 30.0,
            per_item: 1.0,
            max_residual: 0.0,
        };
        assert_eq!(largest(line, 20.0), Largest::Max(0));
    }

    #[test]
    fn min_and_max_treat_unbounded_as_infinity() {
        assert_eq!(Largest::Unbounded.min(Largest::Max(3)), Largest::Max(3));
        assert_eq!(Largest::Max(2).min(Largest::Max(3)), Largest::Max(2));
        assert_eq!(Largest::Unbounded.max(Largest::Max(3)), Largest::Unbounded);
        assert_eq!(Largest::Max(2).max(Largest::Max(3)), Largest::Max(3));
    }
}
