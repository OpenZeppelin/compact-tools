//! Semantic versions, ordered as semver orders them.

use std::cmp::Ordering;
use std::fmt;

/// One dot-separated prerelease identifier.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Identifier {
    Numeric(u64),
    Alphanumeric(String),
}

impl Ord for Identifier {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Identifier::Numeric(a), Identifier::Numeric(b)) => a.cmp(b),
            (Identifier::Numeric(_), Identifier::Alphanumeric(_)) => Ordering::Less,
            (Identifier::Alphanumeric(_), Identifier::Numeric(_)) => Ordering::Greater,
            (Identifier::Alphanumeric(a), Identifier::Alphanumeric(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Identifier {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// `MAJOR.MINOR.PATCH[-prerelease][+build]`; build metadata does not order.
#[derive(Clone, Debug)]
pub struct Version {
    text: String,
    core: (u64, u64, u64),
    prerelease: Vec<Identifier>,
}

impl Version {
    /// Parses a semver string; `None` when it is not one.
    #[must_use]
    pub fn parse(text: &str) -> Option<Version> {
        let without_build = text.split_once('+').map_or(text, |(version, _)| version);
        let (core, prerelease) = match without_build.split_once('-') {
            Some((core, prerelease)) => (core, Some(prerelease)),
            None => (without_build, None),
        };
        let mut parts = core.split('.').map(number);
        let core = (parts.next()??, parts.next()??, parts.next()??);
        if parts.next().is_some() {
            return None;
        }
        let prerelease = match prerelease {
            None => Vec::new(),
            Some(text) => text
                .split('.')
                .map(|identifier| {
                    if identifier.is_empty()
                        || !identifier
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    {
                        None
                    } else if identifier.bytes().all(|byte| byte.is_ascii_digit()) {
                        number(identifier).map(Identifier::Numeric)
                    } else {
                        Some(Identifier::Alphanumeric(identifier.to_owned()))
                    }
                })
                .collect::<Option<Vec<_>>>()?,
        };
        Some(Version {
            text: text.to_owned(),
            core,
            prerelease,
        })
    }
}

/// A decimal component without a leading zero.
fn number(text: &str) -> Option<u64> {
    if text.is_empty()
        || !text.bytes().all(|byte| byte.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
    {
        return None;
    }
    text.parse().ok()
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| {
            match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.prerelease.cmp(&other.prerelease),
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Version {}

impl fmt::Display for Version {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(text: &str) -> Version {
        Version::parse(text).expect("a valid version")
    }

    #[test]
    fn a_prerelease_sorts_below_its_release() {
        assert!(version("1.0.0-rc.5") < version("1.0.0"));
        assert!(version("1.0.0-rc.5") < version("1.0.2"));
        assert!(version("1.0.1") < version("1.0.2"));
        assert!(version("1.0.2") < version("1.1.0"));
    }

    #[test]
    fn prerelease_identifiers_order_numerically_then_lexically() {
        assert!(version("1.0.0-rc.5") < version("1.0.0-rc.10"));
        assert!(version("1.0.0-alpha") < version("1.0.0-alpha.1"));
        assert!(version("1.0.0-1") < version("1.0.0-alpha"));
        assert!(version("1.0.0-alpha") < version("1.0.0-beta"));
    }

    #[test]
    fn build_metadata_does_not_order() {
        assert_eq!(version("1.0.2+abc"), version("1.0.2"));
    }

    #[test]
    fn malformed_versions_do_not_parse() {
        for text in [
            "",
            "1.0",
            "1.0.0.0",
            "01.0.0",
            "1.0.0-",
            "1.0.0-rc..1",
            "^1.0.2",
            "v1.0.2",
        ] {
            assert!(Version::parse(text).is_none(), "{text}");
        }
    }
}
