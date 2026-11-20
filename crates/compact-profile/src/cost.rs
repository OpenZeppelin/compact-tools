//! Plain-number views of the ledger's cost vector and of one measured transaction.

use serde::{Deserialize, Serialize};

/// One dimension of the ledger's `SyntheticCost`, in its serialized order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Dimension {
    ReadTime,
    ComputeTime,
    BlockUsage,
    BytesWritten,
    BytesChurned,
}

impl Dimension {
    pub const ALL: [Dimension; 5] = [
        Dimension::ReadTime,
        Dimension::ComputeTime,
        Dimension::BlockUsage,
        Dimension::BytesWritten,
        Dimension::BytesChurned,
    ];

    /// The camelCase name the JSON files and reports use.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Dimension::ReadTime => "readTime",
            Dimension::ComputeTime => "computeTime",
            Dimension::BlockUsage => "blockUsage",
            Dimension::BytesWritten => "bytesWritten",
            Dimension::BytesChurned => "bytesChurned",
        }
    }
}

/// A `SyntheticCost`: times in picoseconds, the rest in bytes.
///
/// Serialized as decimal strings, since picosecond sums can pass `2^53`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cost {
    #[serde(with = "decimal")]
    pub read_time: u64,
    #[serde(with = "decimal")]
    pub compute_time: u64,
    #[serde(with = "decimal")]
    pub block_usage: u64,
    #[serde(with = "decimal")]
    pub bytes_written: u64,
    #[serde(with = "decimal")]
    pub bytes_churned: u64,
}

impl Cost {
    #[must_use]
    pub fn get(&self, dimension: Dimension) -> u64 {
        match dimension {
            Dimension::ReadTime => self.read_time,
            Dimension::ComputeTime => self.compute_time,
            Dimension::BlockUsage => self.block_usage,
            Dimension::BytesWritten => self.bytes_written,
            Dimension::BytesChurned => self.bytes_churned,
        }
    }

    /// Dimension-wise sum, saturating like the ledger's `SyntheticCost` addition.
    #[must_use]
    pub fn saturating_add(&self, other: &Cost) -> Cost {
        Cost {
            read_time: self.read_time.saturating_add(other.read_time),
            compute_time: self.compute_time.saturating_add(other.compute_time),
            block_usage: self.block_usage.saturating_add(other.block_usage),
            bytes_written: self.bytes_written.saturating_add(other.bytes_written),
            bytes_churned: self.bytes_churned.saturating_add(other.bytes_churned),
        }
    }

    /// The longer of the two times, as the ledger's `max_time`.
    #[must_use]
    pub fn max_time(&self) -> u64 {
        self.read_time.max(self.compute_time)
    }
}

/// What the ledger reports for one unproven transaction under one parameter set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Measurement {
    pub cost: Cost,
    pub serialized_len: u64,
    pub declared_nodes: u32,
    /// The dismissal cost's longest time, which `cost(params, true)` checks.
    pub time_to_dismiss: u64,
}

impl Measurement {
    /// The ledger's estimate of the proven size, which it charges as `blockUsage`.
    #[must_use]
    pub fn estimated_size(&self) -> u64 {
        self.cost.block_usage
    }
}

/// Serde for a `u64` written as a decimal string.
pub mod decimal {
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serializer};

    /// # Errors
    ///
    /// Whatever the serializer reports.
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    /// # Errors
    ///
    /// The value is not a string of ASCII digits that fits a `u64`.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        parse(&text).ok_or_else(|| {
            D::Error::custom(format!("expected a decimal string of digits, got {text:?}"))
        })
    }

    /// Digits only: no sign, no whitespace, no exponent.
    #[must_use]
    pub fn parse(text: &str) -> Option<u64> {
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_parse_takes_digits_only() {
        assert_eq!(decimal::parse("0"), Some(0));
        assert_eq!(decimal::parse("18446744073709551615"), Some(u64::MAX));
        assert_eq!(decimal::parse("18446744073709551616"), None);
        assert_eq!(decimal::parse("+1"), None);
        assert_eq!(decimal::parse(" 1"), None);
        assert_eq!(decimal::parse(""), None);
    }

    #[test]
    fn cost_round_trips_through_json_as_strings() {
        let cost = Cost {
            read_time: 3_978_000_000,
            compute_time: 8_402_856_575,
            block_usage: 10_983,
            bytes_written: 160,
            bytes_churned: 13_960,
        };
        let json = serde_json::to_string(&cost).expect("a cost serializes");
        assert_eq!(
            json,
            r#"{"readTime":"3978000000","computeTime":"8402856575","blockUsage":"10983","bytesWritten":"160","bytesChurned":"13960"}"#
        );
        assert_eq!(
            serde_json::from_str::<Cost>(&json).expect("it parses back"),
            cost
        );
    }

    #[test]
    fn cost_rejects_a_json_number() {
        let json = r#"{"readTime":1,"computeTime":"1","blockUsage":"1","bytesWritten":"1","bytesChurned":"1"}"#;
        assert!(serde_json::from_str::<Cost>(json).is_err());
    }
}
